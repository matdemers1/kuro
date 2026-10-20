//! The Crunchyroll side, behind a trait so the HTTP contract is testable without Crunchyroll.

use crunchyroll_rs::auth::{DeviceIdentifier, SessionToken};
use crunchyroll_rs::error::ErrorKind;
use crunchyroll_rs::Crunchyroll;
use serde_json::Value;
use std::future::Future;

/// Kurō's own device type: every session it issues is the same device, so refresh tokens stay
/// valid (crunchyroll-rs: the device identifier must match the login that minted the token).
pub const DEVICE_TYPE: &str = "ANDROIDTV";
pub const DEVICE_NAME: &str = "Kurō";

#[derive(Debug, PartialEq, Eq)]
pub enum CrError {
    /// The session is expired, revoked or the credentials are wrong (KURO-REQ-007).
    Expired(String),
    /// Cloudflare or a 401/403 refused the request (KURO-REQ-008).
    Blocked(String),
    /// Anything else Crunchyroll did.
    Upstream(String),
    BadInput(String),
}

impl From<crunchyroll_rs::error::Error> for CrError {
    fn from(err: crunchyroll_rs::error::Error) -> Self {
        let msg = err.to_string();
        match err.kind() {
            ErrorKind::Authentication => CrError::Expired(msg),
            ErrorKind::Block { .. } => CrError::Blocked(msg),
            ErrorKind::Request { status: Some(s) } if s.as_u16() == 401 => CrError::Expired(msg),
            ErrorKind::Request { status: Some(s) } if s.as_u16() == 403 => CrError::Blocked(msg),
            ErrorKind::Input => CrError::BadInput(msg),
            _ => CrError::Upstream(msg),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Linked {
    pub refresh_token: String,
    pub account_id: String,
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryPage {
    /// The session's current refresh token, which the server must persist.
    pub refresh_token: String,
    pub total: Option<u64>,
    /// Entries exactly as Crunchyroll returned them (stored raw in the vault).
    pub items: Vec<Value>,
}

pub trait Cr: Send + Sync + 'static {
    fn link_with_password(
        &self,
        email: String,
        password: String,
        device_id: String,
    ) -> impl Future<Output = Result<Linked, CrError>> + Send;
    fn history_page(
        &self,
        refresh_token: String,
        device_id: String,
        account_id: String,
        page: u32,
        page_size: u32,
    ) -> impl Future<Output = Result<HistoryPage, CrError>> + Send;
}

fn device(device_id: String) -> DeviceIdentifier {
    DeviceIdentifier {
        device_id,
        device_type: DEVICE_TYPE.to_string(),
        device_name: Some(DEVICE_NAME.to_string()),
    }
}

async fn refresh_token_of(cr: &Crunchyroll) -> Result<String, CrError> {
    match cr.session_token().await {
        SessionToken::RefreshToken(t) | SessionToken::EtpRt(t) => Ok(t),
        SessionToken::Anonymous => Err(CrError::Expired("anonymous session".into())),
    }
}

/// The real thing, on crunchyroll-rs.
pub struct LiveCr;

impl Cr for LiveCr {
    async fn link_with_password(
        &self,
        email: String,
        password: String,
        device_id: String,
    ) -> Result<Linked, CrError> {
        // The password lives only for this call; it is never logged, stored or echoed (KURO-ADR-001).
        let cr = Crunchyroll::builder()
            .login_with_credentials(email, password, device(device_id))
            .await?;
        let account = cr.account().await?;
        Ok(Linked {
            refresh_token: refresh_token_of(&cr).await?,
            account_id: account.account_id,
            profile_id: None,
        })
    }

    async fn history_page(
        &self,
        refresh_token: String,
        device_id: String,
        account_id: String,
        page: u32,
        page_size: u32,
    ) -> Result<HistoryPage, CrError> {
        let cr = Crunchyroll::builder()
            .login_with_refresh_token(refresh_token, device(device_id))
            .await?;
        // Raw page access, through the library's authenticated client: the backfill checkpoints
        // by page number, which the library's stream does not expose.
        let url = format!("https://www.crunchyroll.com/content/v2/{account_id}/watch-history");
        let res = cr
            .client()
            .get(url)
            .bearer_auth(cr.access_token().await)
            .query(&[
                ("page", page.to_string()),
                ("page_size", page_size.to_string()),
                ("locale", "en-US".to_string()),
            ])
            .send()
            .await
            .map_err(|e| CrError::Upstream(e.to_string()))?;
        let status = res.status().as_u16();
        let body = res
            .text()
            .await
            .map_err(|e| CrError::Upstream(e.to_string()))?;
        match status {
            200 => {}
            401 => return Err(CrError::Expired(format!("watch-history {status}"))),
            403 => return Err(CrError::Blocked(format!("watch-history {status}"))),
            _ => return Err(CrError::Upstream(format!("watch-history {status}"))),
        }
        let json: Value = serde_json::from_str(&body).map_err(|_| {
            if body.contains("cf-") || body.contains("Cloudflare") {
                CrError::Blocked("watch-history returned a Cloudflare page".into())
            } else {
                CrError::Upstream("watch-history returned a body that is not JSON".into())
            }
        })?;
        let items = json
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = json.get("total").and_then(Value::as_u64);
        Ok(HistoryPage {
            refresh_token: refresh_token_of(&cr).await?,
            total,
            items,
        })
    }
}
