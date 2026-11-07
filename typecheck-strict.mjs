// Runs tsconfig.strict.json and reports only the files it lists. The sibling checkouts and
// the modules not yet converted are still compiled for their types, but their errors are not
// ours to fix here.
import path from 'node:path';
import ts from 'typescript';

const configPath = path.resolve(import.meta.dirname, 'tsconfig.strict.json');
const {config, error} = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));

const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
const strictFiles = new Set(parsed.fileNames.map(name => path.resolve(name)));
const program = ts.createProgram(parsed.fileNames, parsed.options);

const diagnostics = [
  ...parsed.errors,
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSourceFiles()
    .filter(file => strictFiles.has(path.resolve(file.fileName)))
    .flatMap(file => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)])
];

const host = {
  getCanonicalFileName: name => name,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine
};
if (diagnostics.length) {
  process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
  console.log(`${diagnostics.length} error(s) in ${strictFiles.size} strict file(s)`);
  process.exitCode = 1;
} else {
  console.log(`${strictFiles.size} strict file(s) clean`);
}
