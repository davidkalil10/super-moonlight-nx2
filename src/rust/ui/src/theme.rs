//! The console's dark and light looks, as the page colours, and the stored choice between them.
//! Colour words are 0xAABBGGRR, as the page and ui.frag read them.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Preference {
    #[default]
    System,
    Dark,
    Light,
}

impl Preference {
    pub const ALL: [Preference; 3] = [Self::System, Self::Dark, Self::Light];

    pub fn from_index(index: u8) -> Self {
        Self::ALL.get(usize::from(index)).copied().unwrap_or_default()
    }

    pub fn saved(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::System => "System",
            Self::Dark => "Dark",
            Self::Light => "Light",
        }
    }

    /// The look to draw: the choice, or the console's own when the choice is System. Without a
    /// reading from the console, System is dark.
    pub fn resolve(self, console_dark: Option<bool>) -> Look {
        match self {
            Self::Dark => Look::Dark,
            Self::Light => Look::Light,
            Self::System if console_dark == Some(false) => Look::Light,
            Self::System => Look::Dark,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Look {
    #[default]
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub ground: u32,
    pub panel: u32,
    pub line: u32,
    pub ink: u32,
    pub dim: u32,
    pub faint: u32,
    pub accent: u32,
    pub ok: u32,
    pub warn: u32,
    pub scrim: u32,
}

const fn rgb(red: u32, green: u32, blue: u32) -> u32 {
    0xff00_0000 | blue << 16 | green << 8 | red
}

impl Look {
    pub const fn palette(self) -> Palette {
        match self {
            Self::Dark => Palette {
                ground: rgb(0x1f, 0x23, 0x20),
                panel: rgb(0x2c, 0x31, 0x2d),
                line: rgb(0x45, 0x4b, 0x46),
                ink: rgb(0xf2, 0xf4, 0xf0),
                dim: rgb(0xa3, 0xaa, 0xa4),
                faint: rgb(0x70, 0x78, 0x71),
                accent: rgb(0x3f, 0xd2, 0xf0),
                ok: rgb(0x6f, 0xdc, 0x8c),
                warn: rgb(0xf2, 0xc1, 0x4e),
                scrim: 0x3800_0000,
            },
            Self::Light => Palette {
                ground: rgb(0xeb, 0xeb, 0xeb),
                panel: rgb(0xff, 0xff, 0xff),
                line: rgb(0xc9, 0xc9, 0xc9),
                ink: rgb(0x2d, 0x2d, 0x2d),
                dim: rgb(0x6c, 0x6c, 0x6c),
                faint: rgb(0x85, 0x85, 0x85),
                accent: rgb(0x00, 0x7f, 0xa8),
                ok: rgb(0x1f, 0x9d, 0x55),
                warn: rgb(0xb7, 0x79, 0x1f),
                scrim: 0x2600_0000,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_follows_the_console_and_fails_soft_to_dark() {
        assert_eq!(Preference::System.resolve(None), Look::Dark);
        assert_eq!(Preference::System.resolve(Some(true)), Look::Dark);
        assert_eq!(Preference::System.resolve(Some(false)), Look::Light);
        assert_eq!(Preference::Light.resolve(Some(true)), Look::Light);
        assert_eq!(Preference::Dark.resolve(Some(false)), Look::Dark);
    }
}
