function logToMain(text) {
  self.postMessage({ type: 'log', text: text });
}

logToMain("Worker: Initializing...");


// Memory part
let wasmMemory = null;
function getWASMMemory() {
  if (wasmMemory === null) {
    wasmMemory = new WebAssembly.Memory({
      'initial': 1024,  // 64MB
      'maximum': 16384, // 1024MB
    });
  }
  return wasmMemory;
}


// Verilator blob loading part
let verilatorLoaded = false;
let verilatorBlob = null;
async function loadVerilatorWasmBinary() {
	if (verilatorLoaded) return;
	const url = 'verilator_bin.wasm';
	const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load WASM file verilator_bin.wasm: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    verilatorBlob = new Uint8Array(buffer);
    console.log(`Loaded verilator_bin.wasm (${verilatorBlob.length} bytes)`);
    verilatorLoaded = true;
}

async function loadVerilator() {
	if (verilatorLoaded) return;
	importScripts('verilator_bin.js');
	await loadVerilatorWasmBinary();
}


// Verilator WASM module caching and creation part
let verilator_wasm_cache = null;
let CACHE_WASM_MODULES = true;

function getWASMModule() {
  if (verilator_wasm_cache === null) {
    const verilator_wasm = new WebAssembly.Module(verilatorBlob);
    if (CACHE_WASM_MODULES) {
      verilator_wasm_cache = verilator_wasm;
    }
	return verilator_wasm;
  }
  return verilator_wasm_cache;
}

function moduleInstFn() {
  return function (imports, ri) {
    let mod = getWASMModule();
    let inst = new WebAssembly.Instance(mod, imports);
    ri(inst);
    return inst.exports;
  }
}

var print_fn = function (s) {
  console.log(s);
  logToMain(s);
}

self.onmessage = (e) => {
  logToMain("Worker: Received Verilog code from main page.");
  const verilogCode = e.data.code;
  const VIRTUAL_FILE_NAME = 'lint_target.v';

  // 7. Write the Verilog code to the virtual file system.
  try {
    Module.FS.writeFile(VIRTUAL_FILE_NAME, verilogCode);
    logToMain(`Worker: Wrote virtual file: /${VIRTUAL_FILE_NAME}`);
  } catch (err) {
    logToMain(`Worker: Error writing to VFS: ${err}`);
    return;
  }

  // 8. Prepare the command-line arguments.
  const args = [
    '--Wall',         // Enable all common warnings [3, 4]
    VIRTUAL_FILE_NAME // The file to lint
  ];

  // 9. Execute Verilator.
  logToMain(`Worker: Executing: ${args.join(' ')}\n------------------`);
  try {
    // This runs the C++ main() function [5]
    Module.callMain(args);
  } catch (e) {
    logToMain(`Worker: Runtime exception (this is often normal): ${e}`);
  }
  logToMain("------------------\nWorker: Linting complete.");
  self.postMessage({ type: 'done' });
};

try {
	loadVerilator().then(() => {
		logToMain("Worker: Loaded verilator_bin.js successfully.");
	{
			let verilator_mod = self.verilator_bin({
				instantiateWasm: moduleInstFn(),
				noInitialRun: true,
				noExitRuntime: true,
				print: print_fn,
				printErr: (s) => {console.error(s); },
				wasmMemory: getWASMMemory(),
			});
			const args = ['--version'];
			const mainFn = verilator_mod.callMain || verilator_mod.run;
			mainFn(args);
		}

		{
			let stderr_capture = [];
			let verilator_mod = self.verilator_bin({
				instantiateWasm: moduleInstFn(),
				noInitialRun: true,
				noExitRuntime: true,
				print: print_fn,
				printErr: (s) => { stderr_capture.push(s); },
				wasmMemory: getWASMMemory(),
			});
			const DUMMY_FILE_NAME = 'test.sv';
const DUMMY_FILE_CONTENT = `
module test(input logic test, input logic unused, output logic out);
	assign out = test;
endmodule

module top(input logic a);
	test t1(.test(a), .unused(_1),  .out(_2));
endmodule
`;

			verilator_mod.FS.writeFile(DUMMY_FILE_NAME, DUMMY_FILE_CONTENT);
			const args = ['--lint-only', '--Wall', '-Wno-DECLFILENAME', '-Wno-UNOPT', '-Wno-UNOPTFLAT', DUMMY_FILE_NAME];
			const mainFn = verilator_mod.callMain || verilator_mod.run;
			mainFn(args); // execution is synchronous
			if (stderr_capture.length > 1) {
				stderr_capture.pop();
				for (let line of stderr_capture) {
					logToMain(line);
				}
			}
		}

		console.log('Run called?');
	});

} catch (e) {
  logToMain(`Worker: CRITICAL ERROR: Failed to load verilator_bin.js. ${e}`);
}