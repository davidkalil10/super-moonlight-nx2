//! `/applist`: the host's apps in its own order.

use alloc::{string::String, vec::Vec};

use crate::{serverinfo::Error, xml};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct App {
    pub id: u32,
    pub title: String,
    pub hdr: bool,
}

pub fn parse(body: &str) -> Result<Vec<App>, Error> {
    match xml::root_status(body) {
        Some((200, _)) => {}
        Some((code, _)) => return Err(Error::Status(code)),
        None => return Err(Error::Malformed),
    }

    xml::elements(body, "App")
        .map(|app| {
            let id = xml::text(app, "ID").and_then(|id| id.trim().parse().ok());
            let title = xml::text(app, "AppTitle");
            let hdr = xml::text(app, "IsHdrSupported").is_some_and(|flag| flag.trim() == "1");
            match (id, title) {
                (Some(id), Some(title)) => Ok(App { id, title, hdr }),
                _ => Err(Error::Malformed),
            }
        })
        .collect()
}
