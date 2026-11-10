"""Hands the console its one-time session, and any Civ7 files it lacks, over its FTP server."""
import ftplib
import io

from . import civ7

APP_DIR = "/switch/moonlight-nx2"
CLIENT_DIR = APP_DIR + "/rust-client"
SESSION = "auth-session"


class Unreachable(Exception):
    pass


class Refused(Exception):
    pass


class FtpConsole:
    """The console's `rust-client` directory."""

    def __init__(self, address, port, timeout=10):
        self.ftp = ftplib.FTP()
        try:
            self.ftp.connect(address, port, timeout=timeout)
            self.ftp.login()
            self.ftp.voidcmd("TYPE I")
        except (OSError, EOFError, ftplib.Error) as error:
            self.ftp.close()
            raise Unreachable(f"no FTP server at {address}:{port} ({error})") from None
        for directory in (APP_DIR, CLIENT_DIR):
            try:
                self.ftp.mkd(directory)
            except ftplib.error_perm:
                pass

    def names(self):
        try:
            return {name.rsplit("/", 1)[-1] for name in self.ftp.nlst(CLIENT_DIR)}
        except ftplib.error_perm:
            return set()

    def store(self, name, data):
        self.ftp.storbinary(f"STOR {CLIENT_DIR}/{name}", io.BytesIO(data))

    def fetch(self, name):
        data = io.BytesIO()
        self.ftp.retrbinary(f"RETR {CLIENT_DIR}/{name}", data.write)
        return data.getvalue()

    def close(self):
        try:
            self.ftp.quit()
        except ftplib.all_errors:
            self.ftp.close()


def stage(console, session, replace, imports):
    """Stores the session and the imports the console lacks; returns one line per file."""
    present = console.names()
    if SESSION in present and not replace:
        raise Refused("the console already holds a session; run again with --replace")
    notes = []
    wanted = civ7.missing_on_console(imports, present)
    for name in imports:
        if name in wanted:
            console.store(name, wanted[name])
            notes.append(f"import: {name} copied")
        else:
            notes.append(f"import: {name} kept, the console has its own")
    console.store(SESSION, session)
    if console.fetch(SESSION) != session:
        raise Refused("the session read back from the console differs")
    return notes
