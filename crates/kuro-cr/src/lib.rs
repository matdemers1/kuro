//! kuro-cr — the only part of Kurō that talks to Crunchyroll (KURO-ADR-009).
//!
//! It holds no state: the server passes the session on every call and persists the rotated
//! refresh token that comes back. It listens only on the compose network (KURO-REQ-056).

pub mod catalog;
pub mod cr;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cr::{Cr, CrError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Serialize)]
pub struct Health {
    pub ok: bool,
    pub version: &'static str,
}

pub async fn healthz() -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

impl IntoResponse for CrError {
    fn into_response(self) -> Response {
        // The kind is the contract; the message is for logs and the sync health panel.
        let (status, kind, message) = match self {
            CrError::Expired(m) => (StatusCode::UNAUTHORIZED, "expired", m),
            CrError::Blocked(m) => (StatusCode::SERVICE_UNAVAILABLE, "blocked", m),
            CrError::Upstream(m) => (StatusCode::BAD_GATEWAY, "upstream", m),
            CrError::BadInput(m) => (StatusCode::BAD_REQUEST, "bad_input", m),
        };
        (status, Json(json!({ "error": kind, "message": message }))).into_response()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBody {
    pub email: String,
    pub password: String,
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBody {
    pub refresh_token: String,
    pub device_id: String,
    pub account_id: String,
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

fn default_page_size() -> u32 {
    100
}

fn non_empty(fields: &[(&str, &str)]) -> Result<(), CrError> {
    for (name, value) in fields {
        if value.trim().is_empty() {
            return Err(CrError::BadInput(format!("{name} is required")));
        }
    }
    Ok(())
}

async fn link<C: Cr>(
    State(cr): State<Arc<C>>,
    Json(body): Json<LinkBody>,
) -> Result<impl IntoResponse, CrError> {
    non_empty(&[
        ("email", &body.email),
        ("password", &body.password),
        ("deviceId", &body.device_id),
    ])?;
    let linked = cr
        .link_with_password(body.email, body.password, body.device_id)
        .await?;
    Ok(Json(json!({
        "refreshToken": linked.refresh_token,
        "accountId": linked.account_id,
        "profileId": linked.profile_id,
    })))
}

async fn history<C: Cr>(
    State(cr): State<Arc<C>>,
    Json(body): Json<HistoryBody>,
) -> Result<impl IntoResponse, CrError> {
    non_empty(&[
        ("refreshToken", &body.refresh_token),
        ("deviceId", &body.device_id),
        ("accountId", &body.account_id),
    ])?;
    if body.page == 0 || body.page_size == 0 || body.page_size > 1000 {
        return Err(CrError::BadInput(
            "page starts at 1 and pageSize is 1..=1000".into(),
        ));
    }
    let page = cr
        .history_page(
            body.refresh_token,
            body.device_id,
            body.account_id,
            body.page,
            body.page_size,
        )
        .await?;
    Ok(Json(
        json!({ "refreshToken": page.refresh_token, "total": page.total, "items": page.items }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CmsBody {
    pub refresh_token: String,
    pub device_id: String,
    pub path: String,
}

async fn cms<C: Cr>(
    State(cr): State<Arc<C>>,
    Json(body): Json<CmsBody>,
) -> Result<impl IntoResponse, CrError> {
    non_empty(&[
        ("refreshToken", &body.refresh_token),
        ("deviceId", &body.device_id),
    ])?;
    let path = catalog::allowed_cms_path(&body.path)
        .ok_or_else(|| CrError::BadInput("that catalog path is not one Kurō reads".into()))?;
    let result = cr.cms(body.refresh_token, body.device_id, path).await?;
    Ok(Json(
        json!({ "refreshToken": result.refresh_token, "body": result.body }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipBody {
    pub episode_id: String,
}

async fn skip_events<C: Cr>(
    State(cr): State<Arc<C>>,
    Json(body): Json<SkipBody>,
) -> Result<impl IntoResponse, CrError> {
    if !catalog::is_episode_id(&body.episode_id) {
        return Err(CrError::BadInput("not an episode id".into()));
    }
    Ok(Json(
        json!({ "events": cr.skip_events(body.episode_id).await? }),
    ))
}

pub fn router<C: Cr>(cr: Arc<C>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/session/password", post(link::<C>))
        .route("/history", post(history::<C>))
        .route("/cms", post(cms::<C>))
        .route("/skip-events", post(skip_events::<C>))
        .with_state(cr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use cr::{HistoryPage, Linked};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    struct FakeCr;

    impl Cr for FakeCr {
        async fn cms(
            &self,
            rt: String,
            _d: String,
            path: String,
        ) -> Result<cr::CmsResult, CrError> {
            Ok(cr::CmsResult {
                refresh_token: format!("{rt}-rotated"),
                body: json!({ "path": path }),
            })
        }
        async fn skip_events(&self, id: String) -> Result<Option<Value>, CrError> {
            Ok((id == "GEPWITH").then(|| json!({ "credits": { "start": 1300.5, "end": 1390.0 } })))
        }
        async fn link_with_password(
            &self,
            email: String,
            password: String,
            _device: String,
        ) -> Result<Linked, CrError> {
            if password == "right" && email == "owner@example.com" {
                Ok(Linked {
                    refresh_token: "rt-1".into(),
                    account_id: "00000000-0000-4000-8000-000000000001".into(),
                    profile_id: None,
                })
            } else {
                Err(CrError::Expired("bad credentials".into()))
            }
        }
        async fn history_page(
            &self,
            rt: String,
            _d: String,
            _a: String,
            page: u32,
            _s: u32,
        ) -> Result<HistoryPage, CrError> {
            match rt.as_str() {
                "blocked" => Err(CrError::Blocked("cloudflare".into())),
                "expired" => Err(CrError::Expired("revoked".into())),
                _ => Ok(HistoryPage {
                    refresh_token: format!("{rt}-rotated"),
                    total: Some(250),
                    items: vec![json!({ "id": format!("EP{page}") })],
                }),
            }
        }
    }

    async fn call(path: &str, body: Value) -> (StatusCode, Value) {
        let res = router(Arc::new(FakeCr))
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn healthz_reports_ok() {
        let res = router(Arc::new(FakeCr))
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    #[tokio::test]
    async fn links_with_a_password_and_never_echoes_it() {
        let (status, body) = call(
            "/session/password",
            json!({ "email": "owner@example.com", "password": "right", "deviceId": "d" }),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["refreshToken"], "rt-1");
        assert!(!body.to_string().contains("right"));
    }

    #[tokio::test]
    async fn wrong_credentials_are_expired() {
        let (status, body) = call(
            "/session/password",
            json!({ "email": "owner@example.com", "password": "wrong", "deviceId": "d" }),
        )
        .await;
        assert_eq!(status, 401);
        assert_eq!(body["error"], "expired");
    }

    #[tokio::test]
    async fn history_returns_the_rotated_token_and_raw_items() {
        let (status, body) = call(
            "/history",
            json!({ "refreshToken": "rt", "deviceId": "d", "accountId": "a", "page": 3 }),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["refreshToken"], "rt-rotated");
        assert_eq!(body["total"], 250);
        assert_eq!(body["items"][0]["id"], "EP3");
    }

    #[tokio::test]
    async fn blocked_and_expired_are_told_apart() {
        let (s1, b1) = call(
            "/history",
            json!({ "refreshToken": "blocked", "deviceId": "d", "accountId": "a", "page": 1 }),
        )
        .await;
        assert_eq!(
            (s1, b1["error"].as_str()),
            (StatusCode::SERVICE_UNAVAILABLE, Some("blocked"))
        );
        let (s2, b2) = call(
            "/history",
            json!({ "refreshToken": "expired", "deviceId": "d", "accountId": "a", "page": 1 }),
        )
        .await;
        assert_eq!(
            (s2, b2["error"].as_str()),
            (StatusCode::UNAUTHORIZED, Some("expired"))
        );
    }

    #[tokio::test]
    async fn cms_passes_allowed_paths_and_refuses_the_rest() {
        let (s, b) = call(
            "/cms",
            json!({ "refreshToken": "rt", "deviceId": "d", "path": "seasons/GYQ4/episodes" }),
        )
        .await;
        assert_eq!(s, 200);
        assert_eq!(b["body"]["path"], "seasons/GYQ4/episodes");
        assert_eq!(b["refreshToken"], "rt-rotated");
        let (s, b) = call(
            "/cms",
            json!({ "refreshToken": "rt", "deviceId": "d", "path": "../accounts/v1/me" }),
        )
        .await;
        assert_eq!(
            (s, b["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("bad_input"))
        );
    }

    #[tokio::test]
    async fn skip_events_returns_markers_or_null() {
        let (_, b) = call("/skip-events", json!({ "episodeId": "GEPWITH" })).await;
        assert_eq!(b["events"]["credits"]["start"], 1300.5);
        let (_, b) = call("/skip-events", json!({ "episodeId": "GEPNONE" })).await;
        assert!(b["events"].is_null());
        let (s, _) = call("/skip-events", json!({ "episodeId": "../x" })).await;
        assert_eq!(s, 400);
    }

    #[tokio::test]
    async fn refuses_page_zero_and_missing_fields() {
        let (s, _) = call(
            "/history",
            json!({ "refreshToken": "rt", "deviceId": "d", "accountId": "a", "page": 0 }),
        )
        .await;
        assert_eq!(s, 400);
        let (s, _) = call(
            "/session/password",
            json!({ "email": "", "password": "x", "deviceId": "d" }),
        )
        .await;
        assert_eq!(s, 400);
    }
}
