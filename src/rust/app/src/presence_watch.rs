//! Asks each saved PC in turn whether Sunshine answers, while the hosts page is up.

use crate::wake_connect::Network;
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_ui::{
    model::{Address, Host},
    presence::{self, ANSWER_TIMEOUT_MS, Rounds, SUNSHINE_PORT},
};

struct Asking<S> {
    socket: S,
    address: Address,
    deadline_ms: u64,
}

pub enum Seen {
    Nothing,
    Answer { address: Address, online: bool },
    Retired,
}

pub struct Watch<S> {
    rounds: Rounds,
    asking: Option<Asking<S>>,
}

impl<S> Default for Watch<S> {
    fn default() -> Self {
        Self {
            rounds: Rounds::default(),
            asking: None,
        }
    }
}

impl<S: Socket> Watch<S> {
    pub fn restart(&mut self) {
        self.rounds.restart();
    }

    /// False when a close failed and the process must retire.
    pub fn stop(&mut self) -> bool {
        !matches!(
            self.asking.take().map(|mut asking| asking.socket.close()),
            Some(Err(_))
        )
    }

    pub fn poll<C: Network<Socket = S>>(
        &mut self,
        connections: &mut C,
        hosts: &[Host],
        now_ms: u64,
    ) -> Seen {
        if let Some(asking) = self.asking.as_mut() {
            let online = match asking.socket.poll_connect() {
                Ok(true) => true,
                Ok(false) | Err(IoError::WouldBlock | IoError::Interrupted)
                    if now_ms < asking.deadline_ms =>
                {
                    return Seen::Nothing;
                }
                _ => false,
            };
            let address = asking.address;
            return if self.stop() {
                Seen::Answer { address, online }
            } else {
                Seen::Retired
            };
        }
        let Some(host) = self
            .rounds
            .next(hosts.len(), now_ms)
            .and_then(|index| hosts.get(index))
        else {
            return Seen::Nothing;
        };
        let Some(target) = presence::ipv4(host.address.as_str()) else {
            return Seen::Nothing;
        };
        match connections.connect(target, SUNSHINE_PORT) {
            Ok(socket) => {
                self.asking = Some(Asking {
                    socket,
                    address: host.address,
                    deadline_ms: now_ms.saturating_add(ANSWER_TIMEOUT_MS),
                });
                Seen::Nothing
            }
            Err(_) => Seen::Answer {
                address: host.address,
                online: false,
            },
        }
    }
}
