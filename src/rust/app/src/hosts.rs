//! Saved hosts: the app keeps the `ui::hosts::HostBook` and applies the service's host actions
//! through CLAUDE2's `Store`. A book that failed to load is never written back.

use crate::service::Action;
use moonlight_nx2_ui::hosts::{self, HostBook};
use moonlight_nx2_ui::json::Json;
use moonlight_nx2_ui::model::Host;
use moonlight_nx2_ui::store::{Files, Store};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// hosts.json could not be loaded; show `message()` and keep the file untouched.
    Load(hosts::Error),
    /// The book refused the host (more than the model shows).
    Book(hosts::Error),
    /// Writing hosts.json failed; the change stays pending for the next save.
    Save,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Error::Load(error) | Error::Book(error) => error.message(),
            Error::Save => "hosts.json could not be saved",
        }
    }
}

pub struct Hosts {
    book: HostBook,
    load_error: Option<hosts::Error>,
}

impl Hosts {
    pub fn load<F: Files>(store: &mut Store<F>, json: &mut Json) -> Self {
        match store.load_hosts(json) {
            Ok(book) => Self {
                book,
                load_error: None,
            },
            Err(error) => Self {
                book: HostBook::default(),
                load_error: Some(error),
            },
        }
    }

    pub fn hosts(&self) -> &[Host] {
        self.book.hosts()
    }

    pub fn load_error(&self) -> Option<Error> {
        self.load_error.map(Error::Load)
    }

    /// Merges hosts mDNS found and saves the book when it grew. `Ok(true)` when the list changed.
    pub fn discovered<F: Files>(
        &mut self,
        found: &[Host],
        store: &mut Store<F>,
    ) -> Result<bool, Error> {
        if let Some(error) = self.load_error {
            return Err(Error::Load(error));
        }
        if !self.book.discovered(found).map_err(Error::Book)? {
            return Ok(false);
        }
        if !store.save_hosts(&mut self.book) {
            return Err(Error::Save);
        }
        Ok(true)
    }

    /// Applies `RememberHost`/`ForgetHost`. `Ok(true)` when the host list changed, so the
    /// caller dispatches `Event::Hosts { hosts: self.hosts() }`. Other actions are ignored.
    pub fn apply<F: Files>(
        &mut self,
        action: &Action,
        store: &mut Store<F>,
    ) -> Result<bool, Error> {
        let host_action = matches!(
            action,
            Action::RememberHost(_) | Action::ForgetHost(_) | Action::RenameHost(_)
        );
        if !host_action {
            return Ok(false);
        }
        if let Some(error) = self.load_error {
            return Err(Error::Load(error));
        }

        let changed = match action {
            Action::RememberHost(host) => self.book.remember(host).map_err(Error::Book)?,
            Action::RenameHost(host) => self.book.rename(host),
            Action::ForgetHost(host) => {
                self.book.forget(host);
                false
            }
            _ => false,
        };

        if !store.save_hosts(&mut self.book) {
            return Err(Error::Save);
        }
        Ok(changed)
    }
}
