//! `moonlight-nx2-host display ...`: look at, try and undo display matching by hand.

use super::{Mode, Session, Setting};

pub const USAGE: &str = "display status | plan WIDTHxHEIGHT@FPS | apply WIDTHxHEIGHT@FPS | restore";

pub fn run(arguments: &[String]) -> Result<(), String> {
    let mut session = Session::from_environment();
    let words: Vec<&str> = arguments.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["status"] => {
            println!("backend: {}", session.backend().name());
            match session.backend().current() {
                Ok(current) => println!("current: {current}"),
                Err(failure) => println!("current: unavailable, {failure}"),
            }
            match session.saved() {
                Ok(Some(saved)) => println!("saved: {saved} (not restored yet)"),
                Ok(None) => println!("saved: nothing to restore"),
                Err(failure) => println!("saved: unreadable, {failure}"),
            }
            Ok(())
        }
        ["plan", mode] => {
            let mode = Mode::parse(mode).ok_or(USAGE)?;
            let current = session.backend().current().map_err(|f| f.to_string())?;
            let change = session
                .backend()
                .plan(&Setting::for_stream(&current.output, mode))
                .map_err(|f| f.to_string())?;
            println!("current: {current}");
            println!("target: {}", change.target);
            if change.commands.is_empty() {
                println!("nothing to change");
            }
            for command in &change.commands {
                println!("would run: {command}");
            }
            Ok(())
        }
        ["apply", mode] => {
            let mode = Mode::parse(mode).ok_or(USAGE)?;
            session.apply(mode).map_err(|f| f.to_string())?;
            session.keep();
            println!("applied; `display restore` puts the previous mode back");
            Ok(())
        }
        ["restore"] => match session.saved() {
            Ok(None) => {
                println!("nothing to restore");
                Ok(())
            }
            _ if session.restore() => Ok(()),
            _ => Err("the saved mode was not restored".into()),
        },
        _ => Err(USAGE.into()),
    }
}
