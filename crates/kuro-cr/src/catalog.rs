//! Read-only catalog paths the server may ask for (KURO-T-1.4). An allowlist, so the sidecar can
//! never be turned into a general proxy into the owner's Crunchyroll account.

/// A Crunchyroll ID: upper/lower letters and digits, as Crunchyroll's GUIDs are.
fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Returns the normalised path under `/content/v2/cms/` when it is one Kurō reads, else None.
pub fn allowed_cms_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let ok = match parts.as_slice() {
        ["objects", ids] => {
            let ids: Vec<&str> = ids.split(',').collect();
            !ids.is_empty() && ids.len() <= 50 && ids.iter().all(|i| is_id(i))
        }
        ["series", id] | ["seasons", id] | ["episodes", id] | ["movie_listings", id] => is_id(id),
        ["series", id, "seasons"]
        | ["seasons", id, "episodes"]
        | ["movie_listings", id, "movies"] => is_id(id),
        _ => false,
    };
    ok.then(|| parts.join("/"))
}

pub fn is_episode_id(s: &str) -> bool {
    is_id(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_catalog_reads_kuro_needs() {
        assert_eq!(
            allowed_cms_path("series/GRDV0019R/seasons").as_deref(),
            Some("series/GRDV0019R/seasons")
        );
        assert_eq!(
            allowed_cms_path("/seasons/GYQ4MKDZE/episodes/").as_deref(),
            Some("seasons/GYQ4MKDZE/episodes")
        );
        assert!(allowed_cms_path("objects/GEP1,GEP2,GEP3").is_some());
    }

    #[test]
    fn refuses_everything_else() {
        for p in [
            "accounts/v1/me",
            "series/../../accounts",
            "series/GR?x=1",
            "objects/",
            "series/GRDV0019R/seasons/extra",
            "playback/v3/x",
        ] {
            assert!(allowed_cms_path(p).is_none(), "{p} must be refused");
        }
        let many = vec!["GEP1"; 51].join(",");
        assert!(allowed_cms_path(&format!("objects/{many}")).is_none());
    }
}
