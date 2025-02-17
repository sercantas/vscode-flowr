import * as vscode from 'vscode';
import { getConfig, getFlowrSession } from '../../extension';
import type { DependenciesQueryResult, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { RotaryBuffer } from '../utils';

const FlowrDependencyViewId = 'flowr-dependencies';
/** returns disposer */
export function registerDependencyView(output: vscode.OutputChannel): () => void {
	const data = new FlowrDependencyTreeView(output);
	const tv = vscode.window.createTreeView(
		FlowrDependencyViewId,
		{
			treeDataProvider: data
		}
	);

	data.setTreeView(tv);
	return () => data.dispose();
}

const emptyDependencies: DependenciesQueryResult = { libraries: [], readData: [], sourcedFiles: [], writtenData: [], '.meta': { timing: -1 } };
const emptyLocationMap: LocationMapQueryResult = { map: {}, '.meta': { timing: -1 } };
type Update = Dependency | undefined | null
class FlowrDependencyTreeView implements vscode.TreeDataProvider<Dependency> {
	private readonly output:               vscode.OutputChannel;
	private activeDependencies:            DependenciesQueryResult = emptyDependencies;
	private locationMap:                   LocationMapQueryResult = emptyLocationMap;
	private readonly _onDidChangeTreeData: vscode.EventEmitter<Update> = new vscode.EventEmitter<Update>();
	readonly onDidChangeTreeData:          vscode.Event<Update> = this._onDidChangeTreeData.event;
	private disposables:                   vscode.Disposable[] = [];
	private parent:                        vscode.TreeView<Dependency> | undefined;

	constructor(output: vscode.OutputChannel) {
		this.output = output;


		this.updateConfig();
		// trigger if config changes:
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(async() => {
			this.updateConfig();
			await this.refresh();
		}));
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(async() => await this.refresh()));

		/* lazy startup patches */
		setTimeout(() => void this.refresh(), 500);
		setTimeout(() => void this.refresh(), 2000);
	}

	private activeInterval:   NodeJS.Timeout | undefined;
	private activeDisposable: vscode.Disposable | undefined;
	private updateConfig() {
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}
		switch(getConfig().get<string>('dependencyView.updateType', 'never')) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => void this.refresh(), getConfig().get<number>('dependencyView.updateInterval', 10000) * 1000);
				break;
			}
			case 'on save':
				this.activeDisposable = vscode.workspace.onWillSaveTextDocument(async() => await this.refresh());
				break;
			case 'on change':
				this.activeDisposable = vscode.workspace.onDidChangeTextDocument(async() => await this.refresh());
				break;
			default:
				this.output.appendLine(`[Dependencies View] Invalid update type: ${getConfig().get<string>('dependencyView.updateType')}`);
		}
	}

	public setTreeView(tv: vscode.TreeView<Dependency>) {
		this.parent = tv;
	}

	async getDependenciesForActiveFile(): Promise<{ dep: DependenciesQueryResult, loc: LocationMapQueryResult} | 'error'> {
		const activeEditor = vscode.window.activeTextEditor;
		if(!activeEditor) {
			return { dep: emptyDependencies, loc: emptyLocationMap };
		}
		const session = await getFlowrSession();
		const [result, error] = await session.retrieveQuery(activeEditor.document, [{ type: 'dependencies' }, { type: 'location-map' }]);
		if(error) {
			this.output.appendLine('[Dependencies View] Error: Could not retrieve dependencies');
			return 'error';
		}
		this.output.appendLine(`[Dependencies View] Refreshed! (Dependencies: ${result.dependencies['.meta'].timing}ms, Locations: ${result['location-map']['.meta'].timing}ms)`);
		return { dep: result.dependencies, loc: result['location-map'] };
	}

	private working = false;
	private readonly textBuffer = new RotaryBuffer<[string, { dep: DependenciesQueryResult, loc: LocationMapQueryResult}]>(5);
	private lastText = '';

	private textFingerprint(text: string): string {
		return text.trim().replace(/\s|^\s*#.*$/gm, '');
	}

	private async refresh() {
		if(this.working) {
			return;
		}
		if(vscode.window.activeTextEditor?.document.languageId !== 'r') {
			return;
		}
		const text = this.textFingerprint(vscode.window.activeTextEditor?.document.getText());
		if(text === this.lastText) {
			return;
		} else {
			this.lastText = text ?? '';
		}
		this.output.appendLine('Refreshing dependencies');
		this.working = true;
		try {
			const has = this.textBuffer.get(e => e?.[0] === text);
			if(has) {
				this.output.appendLine(`[Dependencies View] Using cached dependencies (Dependencies: ${has[1].dep['.meta'].timing}ms, Locations: ${has[1].loc['.meta'].timing}ms)`);
				this.activeDependencies = has[1].dep;
				this.locationMap = has[1].loc;
				this._onDidChangeTreeData.fire(undefined);
				return;
			}
			await vscode.window.withProgress({ location: { viewId: FlowrDependencyViewId } }, () => {
				return this.getDependenciesForActiveFile().then(res => {
					if(res === 'error') {
						if(getConfig().get<boolean>('dependencyView.keepOnError', true)) {
							return;
						} else {
							this.activeDependencies = emptyDependencies;
							this.locationMap = emptyLocationMap;
							this._onDidChangeTreeData.fire(undefined);
							return;
						}
					}
					this.activeDependencies = res.dep;
					this.locationMap = res.loc;
					this.textBuffer.push([text, res]);
					this._onDidChangeTreeData.fire(undefined);
				}).catch(e => {
					this.output.appendLine(`[Dependencies View] Error: ${e}`);
				});
			});
		} catch(e) {
			this.output.appendLine('[Dependencies View] Error: Could not refresh dependencies');
			this.output.appendLine((e as Error).message);
			this.output.appendLine((e as Error).stack ?? '');
		} finally {
			this.working = false;
			setTimeout(() => void this.reveal(), 0);
		}
	}

	private async reveal() {
		const children = await this.getChildren();
		const autoRevealUntil = getConfig().get<number>('dependencyView.autoReveal', 5);
		for(const root of children ?? []) {
			if(root.children?.length && root.children.length <= autoRevealUntil) {
				this.output.appendLine(`Revealing ${JSON.stringify(root.label)} as it has ${root.children.length} children (<= vscode-flowr.dependencyView.autoReveal)`);
				this.parent?.reveal(root, { select: false, focus: false, expand: true });
			}
		}
	}

	getTreeItem(element: Dependency): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}

	getChildren(element?: Dependency): vscode.ProviderResult<Dependency[]> {
		if(element) {
			return element.children ?? [];
		} else {
			return [
				this.makeDependency('Libraries', 'loads the library', this.activeDependencies.libraries, new vscode.ThemeIcon('library'), e => e.libraryName),
				this.makeDependency('Imported Data', 'imports the data', this.activeDependencies.readData, new vscode.ThemeIcon('file-text'), e => e.source),
				this.makeDependency('Sourced Scripts', 'sources the script', this.activeDependencies.sourcedFiles, new vscode.ThemeIcon('file-code'), e => e.file),
				this.makeDependency('Outputs', 'produces the output', this.activeDependencies.writtenData, new vscode.ThemeIcon('new-file'), e => e.destination)
			];
		}
	}

	getParent(element: Dependency): vscode.ProviderResult<Dependency> {
		return element.getParent();
	}

	private makeDependency<E extends DependencyInfo>(label: string, verb: string, elements: E[], themeIcon: vscode.ThemeIcon, getName: (e: E) => string): Dependency {
		const parent = new Dependency({ label, icon: themeIcon, root: true, verb, children: this.makeChildren(getName, elements, verb) });
		parent.children?.forEach(c => c.setParent(parent));
		return parent;
	}


	private makeChildren<E extends DependencyInfo>(getName: (e: E) => string, elements: E[], verb: string): Dependency[] {
		const unknownGuardedName = (e: E) => {
			const name = getName(e);
			if(name === 'unknown' && e.lexemeOfArgument) {
				return name + ': ' + e.lexemeOfArgument;
			}
			return name;
		};
		/* first group by name */
		const grouped = new Map<string, E[]>();
		for(const e of elements) {
			const name = getName(e) + ' (' + e.functionName + ')';
			if(!grouped.has(name)) {
				grouped.set(name, []);
			}
			grouped.get(name)?.push(e);
		}
		return Array.from(grouped.entries()).map(([name, elements]) => {
			if(elements.length === 1) {
				return new Dependency({ label: unknownGuardedName(elements[0]), info: elements[0], locationMap: this.locationMap, verb });
			}
			const res = new Dependency({
				label:       name,
				locationMap: this.locationMap,
				verb,
				icon:        vscode.ThemeIcon.Folder,
				children:    elements.map(e => new Dependency({
					verb,
					label:       unknownGuardedName(e),
					info:        e,
					locationMap: this.locationMap
				}))
			});
			res.children?.forEach(c => c.setParent(res));
			return res;
		});
	}

	public dispose() {
		for(const d of this.disposables) {
			d.dispose();
		}
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
		}
	}
}

interface DependenciesParams {
	readonly parent?:             Dependency;
	readonly verb:                string;
   readonly label:             string;
   readonly root?:             boolean;
   readonly children?:         Dependency[];
   readonly info?:             DependencyInfo;
   readonly collapsibleState?: vscode.TreeItemCollapsibleState;
   readonly icon?:             vscode.ThemeIcon;
   readonly locationMap?:      LocationMapQueryResult;
}

export class Dependency extends vscode.TreeItem {
	public readonly children?: Dependency[];
	private readonly info?:    DependencyInfo;
	private readonly loc?:     SourceRange;
	private parent?:           Dependency;

	public setParent(parent: Dependency) {
		this.parent = parent;
	}

	public getParent(): Dependency | undefined {
		return this.parent;
	}

	constructor(
		{ label, root = false, children = [], info, icon, locationMap, collapsibleState, parent, verb }: DependenciesParams
	) {
		collapsibleState ??= children.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
		super(label, collapsibleState);

		this.children = children;
		this.info = info;
		this.parent = parent;

		if(info) {
			this.loc = locationMap?.map[info.nodeId];
			this.description = `by ${info.functionName} in ${this.loc ? `(L. ${this.loc[0]})` : 'unknown location'}`;
			this.tooltip = `${verb} ${JSON.stringify(this.label)} with the "${info.functionName}" function in ${this.loc ? `line ${this.loc[0]}` : ' an unknown location (right-click for more)'}`;
			if(this.loc && vscode.window.activeTextEditor) {
				const start = new vscode.Position(this.loc[0] - 1, this.loc[1] - 1);
				const end = new vscode.Position(this.loc[2] - 1, this.loc[3]);
				this.command = {
					/* simply move cursor to location */
					command:   'editor.action.goToLocations',
					title:     'go to location',
					arguments: [
						vscode.window.activeTextEditor.document.uri, // anchor uri and position
						start,
						[new vscode.Location(vscode.window.activeTextEditor.document.uri, new vscode.Range(start, end))], // locations
						'goto'
					]
				};
			}
		} else if(children.length > 0) {
			this.tooltip = `${typeof this.label === 'string' ? this.label : ''}${info ? ' (right-click for more!)' : ''}`;
			this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
		} else {
			this.description =`${children.length} item${children.length === 1 ? '' : 's'}`;
		}

		if(icon) {
			this.iconPath = icon;
		}
		if(!root && info) {
			this.contextValue = 'dependency';
		}
	}

	getNodeId(): NodeId | undefined {
		return this.info?.nodeId;
	}

	getLocation(): SourceRange | undefined {
		return this.loc;
	}
}