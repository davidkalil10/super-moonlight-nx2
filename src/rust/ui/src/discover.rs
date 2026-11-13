//! One mDNS query for the `_nvstream._tcp.local` hosts Sunshine and GeForce Experience announce,
//! answers collected for a short window and turned into host candidates. Port of
//! dev legacy/src/streamer/ui/discover.js; the console sends the query itself from an unbound
//! UDP port, so the question asks for a unicast answer (QU) and responders reply to that port.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use crate::model::{Address, Host, Name};

pub const SERVICE: &str = "_nvstream._tcp.local";
pub const MDNS_ADDRESS: [u8; 4] = [224, 0, 0, 251];
pub const MDNS_PORT: u16 = 5353;
/// How long answers are collected after the query.
pub const WINDOW_MS: u64 = 1500;
/// Bounds on what one packet may hold before it is rejected unread.
pub const MAX_PACKET: usize = 9000;
const MAX_RECORDS: usize = 64;
/// Records kept across the packets of one window.
const MAX_KEPT: usize = 256;
const MAX_JUMPS: usize = 16;
const HEADER_BYTES: usize = 12;

const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;
const UNICAST_RESPONSE: u16 = 0x8000;

/// The PTR question for the service with the QU bit set.
pub fn query() -> Vec<u8> {
    let mut packet = alloc::vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in SERVICE.split('.') {
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&TYPE_PTR.to_be_bytes());
    packet.extend_from_slice(&(CLASS_IN | UNICAST_RESPONSE).to_be_bytes());
    packet
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Data {
    Pointer(String),
    Service(String),
    Address([u8; 4]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    name: String,
    data: Data,
}

fn word(packet: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *packet.get(offset)?,
        *packet.get(offset + 1)?,
    ]))
}

/// The name at `offset`, following compression pointers, and the offset after it.
fn read_name(packet: &[u8], mut offset: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    let mut next = None;
    let mut jumps = 0;
    loop {
        let length = *packet.get(offset)? as usize;
        if length == 0 {
            offset += 1;
            break;
        }
        if length & 0xc0 == 0xc0 {
            jumps += 1;
            if jumps > MAX_JUMPS {
                return None;
            }
            let low = *packet.get(offset + 1)? as usize;
            next.get_or_insert(offset + 2);
            offset = ((length & 0x3f) << 8) | low;
            continue;
        }
        if length & 0xc0 != 0 {
            return None;
        }
        let label = packet.get(offset + 1..offset + 1 + length)?;
        if !name.is_empty() {
            name.push('.');
        }
        name.push_str(&String::from_utf8_lossy(label));
        offset += 1 + length;
    }
    Some((name, next.unwrap_or(offset)))
}

/// Answers and additionals of one packet that discovery uses (PTR, SRV, A); questions skipped.
fn parse_packet(packet: &[u8]) -> Option<Vec<Record>> {
    if !(HEADER_BYTES..=MAX_PACKET).contains(&packet.len()) {
        return None;
    }
    let questions = word(packet, 4)?;
    let total = word(packet, 6)? as usize + word(packet, 8)? as usize + word(packet, 10)? as usize;
    if total > MAX_RECORDS {
        return None;
    }
    let mut offset = HEADER_BYTES;
    for _ in 0..questions {
        offset = read_name(packet, offset)?.1 + 4;
    }
    let mut records = Vec::new();
    for _ in 0..total {
        let (owner, next) = read_name(packet, offset)?;
        let kind = word(packet, next)?;
        let length = word(packet, next + 8)? as usize;
        let start = next + 10;
        let end = start + length;
        if end > packet.len() {
            return None;
        }
        offset = end;
        let data = match kind {
            TYPE_PTR => Data::Pointer(read_name(packet, start)?.0),
            TYPE_SRV if length >= 7 => Data::Service(read_name(packet, start + 6)?.0),
            TYPE_A if length == 4 => Data::Address(packet[start..end].try_into().ok()?),
            TYPE_SRV | TYPE_A => return None,
            _ => continue,
        };
        records.push(Record { name: owner, data });
    }
    Some(records)
}

/// The records of one discovery window; malformed packets are skipped whole.
#[derive(Default)]
pub struct Answers {
    records: Vec<Record>,
}

impl Answers {
    pub fn add(&mut self, packet: &[u8]) {
        if let Some(records) = parse_packet(packet) {
            for record in records {
                if self.records.len() < MAX_KEPT && !self.records.contains(&record) {
                    self.records.push(record);
                }
            }
        }
    }

    /// One host per service instance with an SRV target that has an IPv4 address, collapsed
    /// by address; named by the instance label (the target when that is empty).
    pub fn hosts(&self) -> Vec<Host> {
        let mut hosts: Vec<Host> = Vec::new();
        for pointer in &self.records {
            let Data::Pointer(instance) = &pointer.data else {
                continue;
            };
            if !same(&pointer.name, SERVICE) {
                continue;
            }
            let target = self.records.iter().find_map(|record| match &record.data {
                Data::Service(target) if same(&record.name, instance) => Some(target),
                _ => None,
            });
            let Some(target) = target else {
                continue;
            };
            let address = self.records.iter().find_map(|record| match record.data {
                Data::Address(address) if same(&record.name, target) => Some(address),
                _ => None,
            });
            let Some([a, b, c, d]) = address else {
                continue;
            };
            let mut text = Address::new();
            let _ = write!(text, "{a}.{b}.{c}.{d}");
            if hosts.iter().any(|host| host.address == text) {
                continue;
            }
            let cut = instance.len().saturating_sub(SERVICE.len());
            let label = instance
                .get(..cut)
                .filter(|_| instance.get(cut..).is_some_and(|tail| same(tail, SERVICE)))
                .unwrap_or(instance)
                .trim_end_matches('.');
            let label = if label.is_empty() { target } else { label };
            hosts.push(Host {
                name: Name::of(label),
                address: text,
                uniqueid: Address::new(),
                mac: None,
            });
        }
        hosts
    }
}

/// DNS names compare without regard to (ASCII) case.
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(out: &mut Vec<u8>, name: &str) {
        for label in name.split('.') {
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
        out.push(0);
    }

    fn record(out: &mut Vec<u8>, owner: &str, kind: u16, data: &[u8]) {
        name(out, owner);
        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(&[0x80, 1, 0, 0, 0, 120]);
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(data);
    }

    #[test]
    fn query_asks_for_the_service_by_unicast() {
        let packet = query();
        assert_eq!(&packet[4..6], &[0, 1]);
        assert_eq!(&packet[packet.len() - 4..], &[0, 12, 0x80, 1]);
        assert_eq!(packet[12], 9);
    }

    #[test]
    fn answers_name_hosts_by_srv_and_a() {
        let mut packet = alloc::vec![0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0];
        let mut target = Vec::new();
        name(&mut target, "Desktop PC._nvstream._tcp.local");
        record(&mut packet, SERVICE, TYPE_PTR, &target);
        let mut srv = alloc::vec![0, 0, 0, 0, 0xba, 0x6b];
        name(&mut srv, "pc.local");
        record(
            &mut packet,
            "Desktop PC._nvstream._tcp.local",
            TYPE_SRV,
            &srv,
        );
        record(&mut packet, "pc.local", TYPE_A, &[192, 0, 2, 245]);
        let mut answers = Answers::default();
        answers.add(&packet);
        answers.add(&packet);
        answers.add(&[0; 4]);
        let hosts = answers.hosts();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].address.as_str(), "192.0.2.245");
        assert_eq!(hosts[0].name.as_str(), "Desktop PC");
    }

    #[test]
    fn pointer_loops_are_rejected() {
        let mut packet = alloc::vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
        packet.extend_from_slice(&[0xc0, 12]);
        assert!(parse_packet(&packet).is_none());
    }
}
