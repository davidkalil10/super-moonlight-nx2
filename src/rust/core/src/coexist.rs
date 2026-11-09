pub const CLIENT_NAME: [u8; 8] = *b"mlcoex01";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    NotReady,
    Refused(u32),
    Malformed,
    Uncertain,
}

pub trait Backend {
    fn root_ready(&self) -> bool;
    fn open_gpu(&mut self) -> Result<(), Error>;
    fn slots(&mut self) -> Result<(u32, u32), Error>;
    fn register_client(&mut self, name: [u8; 8]) -> Result<u8, Error>;
    fn release_client(&mut self, client: u8) -> Result<(), Error>;
    fn close_gpu(&mut self) -> Result<(), Error>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Root,
    Open,
    Slots,
    Register,
    Release,
    Close,
    Done,
}

#[derive(Clone, Copy, Debug)]
pub struct Report {
    pub stage: Stage,
    pub error: Option<Error>,
    pub cleanup_error: Option<Error>,
    pub slots: Option<(u32, u32)>,
    pub client: Option<u8>,
    pub retained: bool,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.stage == Stage::Done
            && self.error.is_none()
            && self.cleanup_error.is_none()
            && !self.retained
    }
    fn fail(&mut self, stage: Stage, error: Error) {
        self.stage = stage;
        self.error = Some(error);
        self.retained = matches!(error, Error::Uncertain | Error::Malformed);
    }
}

pub fn inspect(backend: &mut impl Backend) -> Report {
    let mut report = Report {
        stage: Stage::Root,
        error: None,
        cleanup_error: None,
        slots: None,
        client: None,
        retained: false,
    };
    if !backend.root_ready() {
        report.fail(Stage::Root, Error::NotReady);
        return report;
    }
    if let Err(error) = backend.open_gpu() {
        report.fail(Stage::Open, error);
        return report;
    }
    match backend.slots() {
        Ok((first, last)) if first <= last => report.slots = Some((first, last)),
        Ok(_) => report.fail(Stage::Slots, Error::Malformed),
        Err(error) => report.fail(Stage::Slots, error),
    }
    if report.error.is_none() {
        match backend.register_client(CLIENT_NAME) {
            Ok(client) => report.client = Some(client),
            Err(error) => report.fail(Stage::Register, error),
        }
    }
    if report.retained {
        return report;
    }
    if let Some(client) = report.client
        && let Err(error) = backend.release_client(client)
    {
        report.fail(Stage::Release, error);
        report.retained = true;
        return report;
    }
    if let Err(error) = backend.close_gpu() {
        if report.error.is_none() {
            report.fail(Stage::Close, error);
        } else {
            report.cleanup_error = Some(error);
        }
        report.retained = true;
    } else if report.error.is_none() {
        report.stage = Stage::Done;
    }
    report
}
