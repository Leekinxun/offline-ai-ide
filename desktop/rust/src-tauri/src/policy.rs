use url::Url;

fn parse(value: &str) -> Option<Url> {
    if value.len() > 8192
        || value
            .chars()
            .any(|character| character <= '\u{20}' || character == '\u{7f}' || character == '\\')
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (url.username().is_empty() && url.password().is_none()).then_some(url)
}

pub fn trusted_ui(value: &str, backend: &Url) -> bool {
    parse(value)
        .is_some_and(|url| url.origin() == backend.origin() && matches!(url.path(), "/" | "/login"))
}

pub fn ready_url(value: &str) -> Option<Url> {
    let url = parse(value)?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

pub fn preview_document(value: &str, backend: &Url) -> bool {
    let Some(url) = parse(value) else {
        return false;
    };
    let segments: Vec<_> = url.path().split('/').collect();
    url.origin() == backend.origin()
        && segments.len() >= 5
        && segments[1] == "preview"
        && uuid::Uuid::parse_str(segments[2]).is_ok()
        && segments[2].len() == 36
        && segments[3].len() == 64
        && segments[3]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
}

pub fn external_url(value: &str, backend: &Url) -> Option<Url> {
    let url = parse(value)?;
    let segments: Vec<_> = url.path().split('/').collect();
    if url.origin() == backend.origin()
        && url.scheme() == "http"
        && url.query().is_none()
        && url.fragment().is_none()
        && segments.len() == 5
        && segments[0].is_empty()
        && segments[1] == "preview"
        && segments[4].is_empty()
        && uuid::Uuid::parse_str(segments[2]).is_ok()
        && segments[2].len() == 36
        && segments[2]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch) || ch == '-')
        && segments[3].len() == 64
        && segments[3]
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
    {
        return Some(url);
    }
    if url.scheme() != "https" {
        return None;
    }
    let hostname = url.host_str()?.trim_end_matches('.');
    if hostname == "localhost"
        || hostname.ends_with(".localhost")
        || hostname == "0.0.0.0"
        || hostname.starts_with("127.")
        || matches!(hostname, "[::]" | "[::1]")
        || hostname.starts_with("[::ffff:")
    {
        return None;
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_permission_is_bound_to_exact_origin_and_workbench_paths() {
        let backend = ready_url("http://127.0.0.1:48321").unwrap();
        for value in [
            "http://127.0.0.1:48321/",
            "http://127.0.0.1:48321/login?next=%2F",
        ] {
            assert!(trusted_ui(value, &backend));
        }
        for value in [
            "http://127.0.0.1:48322/",
            "http://localhost:48321/",
            "http://127.0.0.1:48321/preview/foo",
            "http://user@127.0.0.1:48321/",
            "http://127.0.0.1:48321/\\login",
        ] {
            assert!(!trusted_ui(value, &backend), "{value}");
        }
    }

    #[test]
    fn external_links_match_existing_electron_policy() {
        let backend = ready_url("http://127.0.0.1:48321").unwrap();
        assert!(external_url("https://example.org/path?q=ok", &backend).is_some());
        let preview = format!(
            "http://127.0.0.1:48321/preview/550e8400-e29b-41d4-a716-446655440000/{}/",
            "a".repeat(64)
        );
        assert!(external_url(&preview, &backend).is_some());
        for value in [
            "http://example.org/",
            "file:///etc/passwd",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://localhost./",
            "https://sub.localhost/",
            "https://user@example.org/",
            "http://127.0.0.1:48321/",
            "https://example.org/\n",
        ] {
            assert!(external_url(value, &backend).is_none(), "{value}");
        }
        assert!(external_url(&format!("{preview}?x=1"), &backend).is_none());
    }
}
