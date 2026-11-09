import argparse
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    result = subprocess.run(command, capture_output=True, text=True)
    args.log.write_text(result.stdout + result.stderr)
    failures = [line for line in result.stdout.splitlines() if line.startswith('FAIL')]
    expected = [
        'FAIL only moonlightSdkBackingQuery calls the owner lock: '
        '__wrap_moonlightSdkBackingQuery moonlightSdkBackingQuery',
        'FAIL: 1 failure(s)',
    ]
    accepted = result.returncode == 1 and failures == expected and not result.stderr
    receipt = dict(passed_with_scoped_exception=accepted,
                   original_verifier_exit=result.returncode,
                   exception='Exactly the original getter and the new wrapper call the owner lock',
                   failures=failures, command=command,
                   limits='Original metadata verifier is not an unchanged PASS; wrapper behavior uses focused production-source host tests')
    Path(str(args.log) + '.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
    return 0 if accepted else 1


if __name__ == '__main__':
    sys.exit(main())
