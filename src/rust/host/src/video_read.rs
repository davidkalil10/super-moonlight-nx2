use crate::assemble::{self, Video};
use std::io::{self, Read};

pub(crate) const VIDEO_READ_CALLS: usize = 8;
const VIDEO_READ_BYTES: usize = 8192;

#[derive(Debug)]
pub(crate) enum Error {
    Io(io::Error),
    Media(assemble::Error),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Turn {
    pub exhausted: bool,
    pub eof: bool,
}

pub(crate) fn read_turn(
    reader: &mut impl Read,
    video: &mut Video,
    abandoned: bool,
) -> Result<Turn, Error> {
    let mut turn = Turn::default();
    for index in 0..VIDEO_READ_CALLS {
        let room = if abandoned {
            VIDEO_READ_BYTES
        } else {
            assemble::MAX_BUFFERED_VIDEO_BYTES - video.buffered_bytes()
        };
        if room == 0 {
            break;
        }
        let mut bytes = [0; VIDEO_READ_BYTES];
        match reader.read(&mut bytes[..room.min(VIDEO_READ_BYTES)]) {
            Ok(0) => {
                video.end_data();
                turn.eof = true;
                break;
            }
            Ok(count) => {
                if !abandoned {
                    video.push_data(&bytes[..count]).map_err(Error::Media)?;
                }
                turn.exhausted = index + 1 == VIDEO_READ_CALLS;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                break;
            }
            Err(error) => return Err(Error::Io(error)),
        }
    }
    Ok(turn)
}
