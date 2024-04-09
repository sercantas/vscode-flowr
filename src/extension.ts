import * as vscode from 'vscode'
import { FlowrInternalSession } from './flowr/internal-session'
import { FlowrServerSession } from './flowr/server-session'
import { Settings } from './settings'
import { registerSliceCommands } from './slice'

export const MINIMUM_R_MAJOR = 3
export const BEST_R_MAJOR = 4

export let flowrSession: FlowrInternalSession | FlowrServerSession | undefined
export let outputChannel: vscode.OutputChannel

let flowrStatus: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext) {
	console.log('Loading vscode-flowr')

	outputChannel = vscode.window.createOutputChannel('flowR')

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.dataflow', async() => {
		const activeEditor = vscode.window.activeTextEditor
		if(activeEditor){
			if(!flowrSession) {
				await establishInternalSession()
			}
			const mermaid = await flowrSession?.retrieveDataflowMermaid(activeEditor)
			if(mermaid) {
				const panel = vscode.window.createWebviewPanel('flowr-dataflow', 'Dataflow Graph', vscode.ViewColumn.Beside, {
					enableScripts: true
				})
				panel.webview.html = `
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
	<pre class="mermaid">
    	${mermaid}
	</pre>
	<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</body>
</html>`.trim()
			}
		}
	}))

	registerSliceCommands(context)

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', () => {
		establishServerSession()
	}))
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession()
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.report', () => {
		void vscode.env.openExternal(vscode.Uri.parse('https://github.com/Code-Inspect/flowr/issues/new/choose'))
	}))

	flowrStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	context.subscriptions.push(flowrStatus)
	updateStatusBar()

	context.subscriptions.push(new vscode.Disposable(() => destroySession()))
	process.on('SIGINT', () => destroySession())

	if(getConfig().get<boolean>(Settings.ServerAutoConnect)) {
		establishServerSession()
	}
}

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Settings.Category)
}

export function isVerbose(): boolean {
	return getConfig().get<boolean>(Settings.VerboseLog, false)
}

export async function establishInternalSession() {
	destroySession()
	flowrSession = new FlowrInternalSession(outputChannel)
	await flowrSession.initialize()
}

export function establishServerSession() {
	destroySession()
	flowrSession = new FlowrServerSession(outputChannel)
	flowrSession.initialize()
}

export function destroySession() {
	flowrSession?.destroy()
	flowrSession = undefined
}

export function updateStatusBar() {
	if(flowrSession instanceof FlowrServerSession) {
		flowrStatus.show()
		flowrStatus.text = `$(cloud) flowR server ${flowrSession.state}`
		flowrStatus.tooltip = flowrSession.state === 'connected' ?
			`R version ${flowrSession.rVersion}\nflowR version ${flowrSession.flowrVersion}` : undefined
	} else if(flowrSession instanceof FlowrInternalSession) {
		flowrStatus.show()
		flowrStatus.text = `$(console) flowR shell ${flowrSession.state}`
		flowrStatus.tooltip = flowrSession.state === 'active' ?
			`R version ${flowrSession.rVersion}` : undefined
	} else {
		flowrStatus.hide()
	}
}
