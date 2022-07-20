'use strict';

import * as fs from "fs";
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import * as child_process from "child_process";
import * as vscode from 'vscode';
import { activateSemanticTokensProvider } from './jst'
import { workspace, Disposable, ExtensionContext, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, StreamInfo } from 'vscode-languageclient/node';


import { globby } from 'globby';
import { resolve } from "path";
import { createNoSubstitutionTemplateLiteral } from "typescript";




export function activate(context: ExtensionContext) {
	context.subscriptions.push(
		activateSemanticTokensProvider()
	);

	context.subscriptions.push(
		activateLanguageServer(context)
	);

}

function activateLanguageServer(context: ExtensionContext): Disposable {
	const output = window.createOutputChannel("JML language server")

	function createServer(): Promise<StreamInfo> {
		return new Promise((resolve, reject) => {
			var server = net.createServer((socket) => {
				console.log("Creating server");

				resolve({
					reader: socket,
					writer: socket
				});

				socket.on('end', () => console.log("Disconnected"));
			}).on('error', (err) => {
				// handle errors here
				throw err;
			});

			const javaExecutablePath = findJavaExecutable();
			findJar(context).then(jarFile => {
				// grab a random port.
				server.listen(() => {
					// Start the child java process
					let options = { cwd: workspace.rootPath };

					let args: string[] = [
						'-jar', jarFile, "--mode", "client",
						"--port", (server.address() as net.AddressInfo).port.toString()
					];

					console.log("Starting JML: " + javaExecutablePath + " " + args);

					let process = child_process.spawn(javaExecutablePath, args, options);

					// Send raw output to a file
					const storagePath = context.storageUri?.fsPath;
					if (storagePath && !fs.existsSync(storagePath)) {
						fs.mkdirSync(context.storageUri?.fsPath);
					}

					process.stdout.on("data", chunk => output.append(chunk.toString()))
					process.stderr.on("data", chunk => output.append(chunk.toString()))

					/*let logFile = storagePath + '/vscode-languageserver-java-example.log';
					let logStream = fs.createWriteStream(logFile, { flags: 'w' });
					if (process) {
						process.stdout.pipe(logStream);
						process.stderr.pipe(logStream);
					}*/

					//console.log(`Storing log in '${logFile}'`);
				});
			});
		});
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: ['java'],
		synchronize: {
			// Synchronize the setting section 'languageServerExample' to the server
			configurationSection: 'jml',
			// Notify the server about file changes to '.clientrc files contain in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.{java,jml}')
		}
	};

	// Create the language client and start the client.
	let client = new LanguageClient('openjml', 'OpenJML support', createServer, clientOptions);
	let disposable = client.start();
	context.subscriptions.push(output)
	return client;
}

// MIT Licensed code from: https://github.com/georgewfraser/vscode-javac
function findJavaExecutable(): string {
	let binname = correctBinname("java");

	let config = workspace.getConfiguration('openjml');
	let userDefined = path.resolve(config.get("javaPath") || "java");
	if (fs.existsSync(userDefined)) {
		return userDefined;
	}

	// First search each JAVA_HOME bin folder
	if (process.env['JAVA_HOME']) {
		let workspaces = process.env['JAVA_HOME'].split(path.delimiter);
		for (let i = 0; i < workspaces.length; i++) {
			let binpath = path.join(workspaces[i], 'bin', binname);
			if (fs.existsSync(binpath)) {
				return binpath;
			}
		}
	}

	// Then search PATH parts
	if (process.env['PATH']) {
		let pathparts = process.env['PATH'].split(path.delimiter);
		for (let i = 0; i < pathparts.length; i++) {
			let binpath = path.join(pathparts[i], binname);
			if (fs.existsSync(binpath)) {
				return binpath;
			}
		}
	}

	// Else return the binary name directly (this will likely always fail downstream) 
	return "java";
}

async function findJar(context: ExtensionContext): Promise<string> {
	let config = workspace.getConfiguration('openjml');
	const storagePath = context.storageUri?.fsPath;


	const potentialPaths: string[] = [
		path.join(config.get("jarFile") || "-not-found"),
		path.join(context.extensionPath,
			'..', 'lsp', 'build', 'libs', 'jml-lsp-*-all.jar'),
		path.join(storagePath, "lsp", "jml-lsp-*-all.jar"),
		path.join("${env.HOME}", ".jml-lsp", "jml-lsp-*-all.jar")
	]

	for (const candidate of potentialPaths) {
		const paths = await globby(candidate);
		if (paths.length > 0) {
			return paths[0]
		}
	}

	const locallyInstalled = await workspace.findFiles("**/jml-lsp-*-all.jar");
	if (locallyInstalled) {
		return locallyInstalled[0].fsPath;
	}

	return downloadLanguageServer(storagePath)
}

async function downloadLanguageServer(storagePath: string): Promise<string> {
	let progress: vscode.Progress<any> | undefined;
	let cancel: vscode.CancellationToken | undefined;
	let dest: string | undefined
	let done: Function | false | undefined;

	const request = http.get("https://github.com", function (response) {
		if (response.statusCode == 200) {
			dest = path.join(storagePath, "lsp", response.headers["content-disposition"])
			if (cancel) {
				cancel.onCancellationRequested(() => {
					if (request.destroyed || response.destroyed) return;
					request.destroy();
					response.destroy();
				});
			} else {
				console.error("failed registering cancel token");
			}

			let len = parseInt(response.headers["content-length"] || "0")
			let totalPercent: number = 0;
			response.addListener("data", (chunk) => {
				let increment = chunk.length / len;
				totalPercent += increment;
				if (progress)
					progress.report({
						message: `Downloaded ${(totalPercent * 100).toFixed(2)}%`,
						increment: increment * 100
					});
			})

			const file = fs.createWriteStream(path.resolve())
			response.pipe(file, { end: true });
			// after download completed close filestream
			file.on("end", () => {
				file.close();
				console.log("Download Completed");
			});

			response.on('error', error => {
				file.close()
				window.showErrorMessage("Download error " + error.message)
				console.log(error)
			})
		}
	}).on('error', function (err) { // Handle errors
		if (dest) fs.unlink(dest, (err) => { });
		//if (cb) cb(err.message);
	});

	vscode.window.withProgress({
		cancellable: true,
		location: vscode.ProgressLocation.Notification,
		title: "Downloading jml language server"
	}, (_progress, _cancel) => {
		progress = _progress;
		cancel = _cancel;
		return new Promise((resolve) => {
			if (done === false)
				return resolve(undefined);
			done = resolve;
		});
	});


	return "";
}





function correctBinname(binname: string) {
	if (process.platform === 'win32') {
		return binname + '.exe';
	}
	else {
		return binname;
	}
}


