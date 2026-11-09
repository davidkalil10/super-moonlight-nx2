import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--owner-caller', default='__wrap_moonlightSdkBackingQuery')
    parser.add_argument('--status-file', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if args.status_file is not None:
        if command:
            parser.error('status-file reads an existing log; do not supply a command')
        result = subprocess.CompletedProcess([], int(args.status_file.read_text()), args.log.read_text(), '')
    else:
        result = subprocess.run(command, capture_output=True, text=True)
        args.log.write_text(result.stdout + result.stderr)
    failures = [line for line in result.stdout.splitlines() if line.startswith('FAIL')]
    callers = ' '.join(sorted([args.owner_caller, 'moonlightSdkBackingQuery']))
    expected = [
        'FAIL only moonlightSdkBackingQuery calls the owner lock: ' + callers,
        'FAIL: 1 failure(s)',
    ]
    accepted = result.returncode == 1 and failures == expected and not result.stderr
    receipt = dict(passed_with_scoped_exception=accepted,
                   original_verifier_exit=result.returncode,
                   exception='Exactly the original getter and ' + args.owner_caller + ' call the owner lock',
                   failures=failures, command=command,
                   limits='Original metadata verifier is not an unchanged PASS; wrapper behavior uses focused production-source host tests')
    Path(str(args.log) + '.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
    return 0 if accepted else 1


if __name__ == '__main__':
    sys.exit(main())
