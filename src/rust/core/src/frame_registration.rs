#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum State {
    #[default]
    Unregistered,
    Registered {
        requested: u64,
        permitted: u64,
    },
    Failed(u32),
}

#[derive(Default)]
pub struct Registry {
    state: State,
}

impl Registry {
    pub const fn new() -> Self {
        Self {
            state: State::Unregistered,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn permitted(&self) -> Option<u64> {
        match self.state {
            State::Registered { permitted, .. } => Some(permitted),
            _ => None,
        }
    }

    pub fn register(
        &mut self,
        requested: u64,
        conflict: u32,
        forward: impl FnOnce(u64) -> Result<u64, u32>,
    ) -> Result<u64, u32> {
        match self.state {
            State::Registered {
                requested: previous,
                permitted,
            } if requested == previous => Ok(permitted),
            State::Registered { .. } => Err(conflict),
            State::Failed(result) => Err(result),
            State::Unregistered => match forward(requested) {
                Ok(permitted) => {
                    self.state = State::Registered {
                        requested,
                        permitted,
                    };
                    Ok(permitted)
                }
                Err(result) => {
                    self.state = State::Failed(result);
                    Err(result)
                }
            },
        }
    }
}
