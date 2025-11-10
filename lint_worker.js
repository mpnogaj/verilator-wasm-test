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

function lintVerilogCode(files) {
	let stderr_capture = [];
	let verilator_mod = self.verilator_bin({
		instantiateWasm: moduleInstFn(),
		noInitialRun: true,
		noExitRuntime: true,
		print: print_fn,
		printErr: (s) => { stderr_capture.push(s); },
		wasmMemory: getWASMMemory(),
	});

	const filenames = Object.keys(files);

	filenames.forEach((filename) => {
		verilator_mod.FS.writeFile(filename, files[filename]);
	});

	const args = ['--lint-only', '--Wall', '-Wno-DECLFILENAME', '-Wno-UNOPT', '-Wno-UNOPTFLAT'].concat(filenames);
	const mainFn = verilator_mod.callMain || verilator_mod.run;
	mainFn(args); // execution is synchronous
	if (stderr_capture.length > 1) {
		stderr_capture.pop();
		for (let line of stderr_capture) {
			logToMain(line);
		}
	}
}

self.onmessage = async (e) => {
	if (e.data.type === 'lint') {
		await loadVerilator();
		logToMain("Worker: Starting linting process...");
		const files = e.data.files;

		lintVerilogCode(files);
		self.postMessage({ type: 'done' });
	}
};
