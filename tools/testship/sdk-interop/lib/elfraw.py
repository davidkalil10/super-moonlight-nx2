"""Minimal little-endian ELF64 reader: section headers, names, bodies and the symbol table."""
import struct

SHT_SYMTAB, SHT_RELA, SHT_NOBITS, SHT_SYMTAB_SHNDX = 2, 4, 8, 18
ET_DYN = 3
SHN_UNDEF, SHN_ABS = 0, 0xfff1
BINDS = {0: "LOCAL", 1: "GLOBAL", 2: "WEAK"}
TYPES = {0: "NOTYPE", 1: "OBJECT", 2: "FUNC", 3: "SECTION", 4: "FILE"}
VISIBILITY = {0: "DEFAULT", 1: "INTERNAL", 2: "HIDDEN", 3: "PROTECTED"}
SHDR = "<IIQQQQIIQQ"


class Elf:
    def __init__(self, path):
        self.data = data = open(path, "rb").read()
        if data[:6] != b"\x7fELF\x02\x01":
            raise ValueError(f"{path}: not a little-endian ELF64 file")
        self.ehdr = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
        shoff, shentsize = self.ehdr[6], self.ehdr[11]
        first = struct.unpack_from(SHDR, data, shoff)
        count = self.ehdr[12] or first[5]
        self.shstrndx = first[6] if self.ehdr[13] == 0xffff else self.ehdr[13]
        self.sections = [struct.unpack_from(SHDR, data, shoff + i * shentsize) for i in range(count)]
        names = self.body(self.shstrndx)
        self.names = [self.string(names, s[0]) for s in self.sections]

    @staticmethod
    def string(blob, offset):
        return blob[offset:blob.index(b"\0", offset)].decode()

    def nobits(self, index):
        return self.sections[index][1] == SHT_NOBITS

    def body(self, index):
        s = self.sections[index]
        return b"" if s[1] == SHT_NOBITS else self.data[s[4]:s[4] + s[5]]

    def index(self, name):
        found = [i for i, n in enumerate(self.names) if n == name]
        return found[0] if len(found) == 1 else None

    def has_symtab_shndx(self):
        return any(s[1] == SHT_SYMTAB_SHNDX for s in self.sections)

    def symbols(self):
        """Returns (symtab index, [(name, info, other, shndx, value, size)])."""
        index = next(i for i, s in enumerate(self.sections) if s[1] == SHT_SYMTAB)
        s = self.sections[index]
        strings = self.body(s[6])
        rows = []
        for offset in range(s[4], s[4] + s[5], s[9]):
            name, info, other, shndx, value, size = struct.unpack_from("<IBBHQQ", self.data, offset)
            rows.append((self.string(strings, name), info, other, shndx, value, size))
        return index, rows

    def symbol_rows(self):
        """The symbol table decoded into dicts, with the section name resolved."""
        rows = []
        for name, info, other, shndx, value, size in self.symbols()[1]:
            section = self.names[shndx] if 0 < shndx < len(self.names) else None
            rows.append(dict(name=name, bind=BINDS.get(info >> 4, str(info >> 4)),
                             type=TYPES.get(info & 0xf, str(info & 0xf)), vis=VISIBILITY[other & 3],
                             shndx=shndx, section=section, value=value, size=size))
        return rows

    def relocations(self):
        """Yields (target section index, offset, symbol index, type, addend) for every SHT_RELA entry."""
        for s in self.sections:
            if s[1] != SHT_RELA:
                continue
            for offset in range(s[4], s[4] + s[5], s[9]):
                where, info, addend = struct.unpack_from("<QQq", self.data, offset)
                yield s[7], where, info >> 32, info & 0xffffffff, addend

    def read(self, address, size):
        """File bytes at a virtual address, or None outside every PROGBITS section."""
        for s in self.sections:
            inside = s[3] <= address and address + size <= s[3] + s[5]
            if s[2] & 2 and inside and s[1] != SHT_NOBITS:
                start = s[4] + address - s[3]
                return self.data[start:start + size]
        return None
