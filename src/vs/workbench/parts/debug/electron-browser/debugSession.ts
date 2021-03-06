/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI as uri } from 'vs/base/common/uri';
import * as resources from 'vs/base/common/resources';
import * as nls from 'vs/nls';
import * as platform from 'vs/base/common/platform';
import severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import { Event, Emitter } from 'vs/base/common/event';
import { ISuggestion } from 'vs/editor/common/modes';
import { Position } from 'vs/editor/common/core/position';
import * as aria from 'vs/base/browser/ui/aria/aria';
import { IDebugSession, IConfig, IThread, IRawModelUpdate, IDebugService, IRawStoppedDetails, State, LoadedSourceEvent, IFunctionBreakpoint, IExceptionBreakpoint, ActualBreakpoints, IBreakpoint, IExceptionInfo, AdapterEndEvent, IDebugger } from 'vs/workbench/parts/debug/common/debug';
import { Source } from 'vs/workbench/parts/debug/common/debugSource';
import { mixin } from 'vs/base/common/objects';
import { Thread, ExpressionContainer, Model } from 'vs/workbench/parts/debug/common/debugModel';
import { RawDebugSession } from 'vs/workbench/parts/debug/electron-browser/rawDebugSession';
import product from 'vs/platform/node/product';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { RunOnceScheduler } from 'vs/base/common/async';
import { generateUuid } from 'vs/base/common/uuid';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { normalizeDriveLetter } from 'vs/base/common/labels';
import { IOutputService } from 'vs/workbench/parts/output/common/output';

export class DebugSession implements IDebugSession {

	private id: string;
	private _raw: RawDebugSession;
	private _state: State;
	private _nullCapabilities: DebugProtocol.Capabilities;

	private sources = new Map<string, Source>();
	private threads = new Map<number, Thread>();
	private rawListeners: IDisposable[] = [];
	private fetchThreadsScheduler: RunOnceScheduler;

	private readonly _onDidChangeState = new Emitter<State>();
	private readonly _onDidEndAdapter = new Emitter<AdapterEndEvent>();

	private readonly _onDidLoadedSource = new Emitter<LoadedSourceEvent>();
	private readonly _onDidCustomEvent = new Emitter<DebugProtocol.Event>();


	constructor(
		private _configuration: { resolved: IConfig, unresolved: IConfig },
		public root: IWorkspaceFolder,
		private model: Model,
		@INotificationService private notificationService: INotificationService,
		@IDebugService private debugService: IDebugService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IOutputService private outputService: IOutputService,
	) {
		this.id = generateUuid();
		this.state = State.Initializing;
		this._nullCapabilities = Object.create(null);
	}

	getId(): string {
		return this.id;
	}

	get configuration(): IConfig {
		return this._configuration.resolved;
	}

	get unresolvedConfiguration(): IConfig {
		return this._configuration.unresolved;
	}

	getName(includeRoot: boolean): string {
		return includeRoot && this.root ? `${this.configuration.name} (${resources.basenameOrAuthority(this.root.uri)})` : this.configuration.name;
	}

	get state(): State {
		return this._state;
	}

	set state(value: State) {
		if (this._state !== value) {
			this._state = value;
			this._onDidChangeState.fire(value);
		}
	}

	get capabilities(): DebugProtocol.Capabilities {
		return this._raw ? this._raw.capabilities : this._nullCapabilities;
	}

	//---- events

	get onDidChangeState(): Event<State> {
		return this._onDidChangeState.event;
	}

	get onDidEndAdapter(): Event<AdapterEndEvent> {
		return this._onDidEndAdapter.event;
	}

	//---- DAP events

	get onDidCustomEvent(): Event<DebugProtocol.Event> {
		return this._onDidCustomEvent.event;
	}

	get onDidLoadedSource(): Event<LoadedSourceEvent> {
		return this._onDidLoadedSource.event;
	}


	//---- DAP requests

	/**
	 * create and initialize a new debug adapter for this session
	 */
	initialize(dbgr: IDebugger): TPromise<void> {

		if (this._raw) {
			// if there was already a connection make sure to remove old listeners
			this.dispose();	// TODO: do not use dispose for this!
		}

		return dbgr.getCustomTelemetryService().then(customTelemetryService => {

			return dbgr.createDebugAdapter(this, this.root, this._configuration.resolved, this.outputService).then(debugAdapter => {

				this._raw = new RawDebugSession(debugAdapter, dbgr, this.telemetryService, customTelemetryService);

				return this._raw.start().then(() => {

					this.registerListeners();

					return this._raw.initialize({
						clientID: 'vscode',
						clientName: product.nameLong,
						adapterID: this.configuration.type,
						pathFormat: 'path',
						linesStartAt1: true,
						columnsStartAt1: true,
						supportsVariableType: true, // #8858
						supportsVariablePaging: true, // #9537
						supportsRunInTerminalRequest: true, // #10574
						locale: platform.locale
					}).then(response => {
						this.model.addSession(this);
						this.state = State.Running;
						this.model.setExceptionBreakpoints(this._raw.capabilities.exceptionBreakpointFilters);
					});
				});
			});
		});
	}

	/**
	 * launch or attach to the debuggee
	 */
	launchOrAttach(config: IConfig): TPromise<void> {
		if (this._raw) {

			// __sessionID only used for EH debugging (but we add it always for now...)
			config.__sessionId = this.getId();

			return this._raw.launchOrAttach(config).then(result => {
				return void 0;
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	/**
	 * end the current debug adapter session
	 */
	terminate(restart = false): TPromise<void> {
		if (this._raw) {
			if (this._raw.capabilities.supportsTerminateRequest && this._configuration.resolved.request === 'launch') {
				return this._raw.terminate(restart).then(response => {
					return void 0;
				});
			}
			return this._raw.disconnect(restart).then(response => {
				return void 0;
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	/**
	 * end the current debug adapter session
	 */
	disconnect(restart = false): TPromise<void> {
		if (this._raw) {
			return this._raw.disconnect(restart).then(response => {
				return void 0;
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	/**
	 * restart debug adapter session
	 */
	restart(): TPromise<DebugProtocol.RestartResponse> {
		if (this._raw) {
			return this._raw.restart();
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	sendBreakpoints(modelUri: uri, breakpointsToSend: IBreakpoint[], sourceModified: boolean): TPromise<ActualBreakpoints | undefined> {

		if (!this._raw) {
			return TPromise.wrapError(new Error('no debug adapter'));
		}

		if (!this._raw.readyForBreakpoints) {
			return TPromise.as(undefined);
		}

		const source = this.getSourceForUri(modelUri);
		let rawSource: DebugProtocol.Source;
		if (source) {
			rawSource = source.raw;
		} else {
			const data = Source.getEncodedDebugData(modelUri);
			rawSource = { name: data.name, path: data.path, sourceReference: data.sourceReference };
		}

		if (breakpointsToSend.length && !rawSource.adapterData) {
			rawSource.adapterData = breakpointsToSend[0].adapterData;
		}
		// Normalize all drive letters going out from vscode to debug adapters so we are consistent with our resolving #43959
		rawSource.path = normalizeDriveLetter(rawSource.path);

		return this._raw.setBreakpoints({
			source: rawSource,
			lines: breakpointsToSend.map(bp => bp.lineNumber),
			breakpoints: breakpointsToSend.map(bp => ({ line: bp.lineNumber, column: bp.column, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
			sourceModified
		}).then(response => {

			if (response && response.body) {
				const data: ActualBreakpoints = Object.create(null);
				for (let i = 0; i < breakpointsToSend.length; i++) {
					data[breakpointsToSend[i].getId()] = response.body.breakpoints[i];
				}
				this.model.setBreakpointSessionData(this.getId(), data);
				return data;
			}
			return undefined;
		});
	}

	sendFunctionBreakpoints(fbpts: IFunctionBreakpoint[]): TPromise<ActualBreakpoints | undefined> {
		if (this._raw) {
			if (this._raw.readyForBreakpoints) {
				return this._raw.setFunctionBreakpoints({ breakpoints: fbpts }).then(response => {
					if (response && response.body) {
						const data: ActualBreakpoints = Object.create(null);
						for (let i = 0; i < fbpts.length; i++) {
							data[fbpts[i].getId()] = response.body.breakpoints[i];
						}
						return data;
					}
					return undefined;
				});
			}
			return TPromise.as(undefined);
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	sendExceptionBreakpoints(exbpts: IExceptionBreakpoint[]): TPromise<any> {
		if (this._raw) {
			if (this._raw.readyForBreakpoints && exbpts.length > 0) {
				return this._raw.setExceptionBreakpoints({ filters: exbpts.map(exb => exb.filter) });
			}
			return TPromise.as(null);
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	customRequest(request: string, args: any): TPromise<DebugProtocol.Response> {
		if (this._raw) {
			return this._raw.custom(request, args);
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	stackTrace(threadId: number, startFrame: number, levels: number): TPromise<DebugProtocol.StackTraceResponse> {
		if (this._raw) {
			return this._raw.stackTrace({ threadId, startFrame, levels });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	exceptionInfo(threadId: number): TPromise<IExceptionInfo> {
		if (this._raw) {
			return this._raw.exceptionInfo({ threadId }).then(response => {
				if (response) {
					return {
						id: response.body.exceptionId,
						description: response.body.description,
						breakMode: response.body.breakMode,
						details: response.body.details
					};
				}
				return null;
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	scopes(frameId: number): TPromise<DebugProtocol.ScopesResponse> {
		if (this._raw) {
			return this._raw.scopes({ frameId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	variables(variablesReference: number, filter: 'indexed' | 'named', start: number, count: number): TPromise<DebugProtocol.VariablesResponse | undefined> {
		if (this._raw) {
			return this._raw.variables({ variablesReference, filter, start, count });
		}
		return TPromise.as(undefined);
	}

	evaluate(expression: string, frameId: number, context?: string): TPromise<DebugProtocol.EvaluateResponse> {
		if (this._raw) {
			return this._raw.evaluate({ expression, frameId, context });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	restartFrame(frameId: number, threadId: number): TPromise<DebugProtocol.RestartFrameResponse> {
		if (this._raw) {
			return this._raw.restartFrame({ frameId }, threadId);
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	next(threadId: number): TPromise<DebugProtocol.NextResponse> {
		if (this._raw) {
			return this._raw.next({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	stepIn(threadId: number): TPromise<DebugProtocol.StepInResponse> {
		if (this._raw) {
			return this._raw.stepIn({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	stepOut(threadId: number): TPromise<DebugProtocol.StepOutResponse> {
		if (this._raw) {
			return this._raw.stepOut({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	stepBack(threadId: number): TPromise<DebugProtocol.StepBackResponse> {
		if (this._raw) {
			return this._raw.stepBack({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	continue(threadId: number): TPromise<DebugProtocol.ContinueResponse> {
		if (this._raw) {
			return this._raw.continue({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	reverseContinue(threadId: number): TPromise<DebugProtocol.ReverseContinueResponse> {
		if (this._raw) {
			return this._raw.reverseContinue({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	pause(threadId: number): TPromise<DebugProtocol.PauseResponse> {
		if (this._raw) {
			return this._raw.pause({ threadId });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	terminateThreads(threadIds?: number[]): TPromise<DebugProtocol.TerminateThreadsResponse> {
		if (this._raw) {
			return this._raw.terminateThreads({ threadIds });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	setVariable(variablesReference: number, name: string, value: string): TPromise<DebugProtocol.SetVariableResponse> {
		if (this._raw) {
			return this._raw.setVariable({ variablesReference, name, value });
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	loadSource(resource: uri): TPromise<DebugProtocol.SourceResponse> {

		if (!this._raw) {
			return TPromise.wrapError(new Error('no debug adapter'));
		}

		const source = this.getSourceForUri(resource);
		let rawSource: DebugProtocol.Source;
		if (source) {
			rawSource = source.raw;
		} else {
			// create a Source

			let sourceRef: number;
			if (resource.query) {
				const data = Source.getEncodedDebugData(resource);
				sourceRef = data.sourceReference;
			}

			rawSource = {
				path: resource.with({ scheme: '', query: '' }).toString(true),	// Remove debug: scheme
				sourceReference: sourceRef
			};
		}

		return this._raw.source({ sourceReference: rawSource.sourceReference, source: rawSource });
	}

	getLoadedSources(): TPromise<Source[]> {
		if (this._raw) {
			return this._raw.loadedSources({}).then(response => {
				return response.body.sources.map(src => this.getSource(src));
			}, () => {
				return [];
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	completions(frameId: number, text: string, position: Position, overwriteBefore: number): TPromise<ISuggestion[]> {
		if (this._raw) {
			return this._raw.completions({
				frameId,
				text,
				column: position.column,
				line: position.lineNumber
			}).then(response => {

				const result: ISuggestion[] = [];
				if (response && response.body && response.body.targets) {
					response.body.targets.forEach(item => {
						if (item && item.label) {
							result.push({
								label: item.label,
								insertText: item.text || item.label,
								type: item.type,
								filterText: item.start && item.length && text.substr(item.start, item.length).concat(item.label),
								overwriteBefore: item.length || overwriteBefore
							});
						}
					});
				}

				return result;
			});
		}
		return TPromise.wrapError(new Error('no debug adapter'));
	}

	//---- threads

	getThread(threadId: number): Thread {
		return this.threads.get(threadId);
	}

	getAllThreads(): IThread[] {
		const result: IThread[] = [];
		this.threads.forEach(t => result.push(t));
		return result;
	}

	clearThreads(removeThreads: boolean, reference: number = undefined): void {
		if (reference !== undefined && reference !== null) {
			if (this.threads.has(reference)) {
				const thread = this.threads.get(reference);
				thread.clearCallStack();
				thread.stoppedDetails = undefined;
				thread.stopped = false;

				if (removeThreads) {
					this.threads.delete(reference);
				}
			}
		} else {
			this.threads.forEach(thread => {
				thread.clearCallStack();
				thread.stoppedDetails = undefined;
				thread.stopped = false;
			});

			if (removeThreads) {
				this.threads.clear();
				ExpressionContainer.allValues.clear();
			}
		}
	}

	rawUpdate(data: IRawModelUpdate): void {

		if (data.thread && !this.threads.has(data.threadId)) {
			// A new thread came in, initialize it.
			this.threads.set(data.threadId, new Thread(this, data.thread.name, data.thread.id));
		} else if (data.thread && data.thread.name) {
			// Just the thread name got updated #18244
			this.threads.get(data.threadId).name = data.thread.name;
		}

		if (data.stoppedDetails) {
			// Set the availability of the threads' callstacks depending on
			// whether the thread is stopped or not
			if (data.stoppedDetails.allThreadsStopped) {
				this.threads.forEach(thread => {
					thread.stoppedDetails = thread.threadId === data.threadId ? data.stoppedDetails : { reason: undefined };
					thread.stopped = true;
					thread.clearCallStack();
				});
			} else if (this.threads.has(data.threadId)) {
				// One thread is stopped, only update that thread.
				const thread = this.threads.get(data.threadId);
				thread.stoppedDetails = data.stoppedDetails;
				thread.clearCallStack();
				thread.stopped = true;
			}
		}
	}

	private fetchThreads(stoppedDetails?: IRawStoppedDetails): TPromise<any> {
		return this._raw.threads().then(response => {
			if (response && response.body && response.body.threads) {
				response.body.threads.forEach(thread => {
					this.model.rawUpdate({
						sessionId: this.getId(),
						threadId: thread.id,
						thread,
						stoppedDetails: stoppedDetails && thread.id === stoppedDetails.threadId ? stoppedDetails : undefined
					});
				});
			}
		});
	}

	//---- private

	private registerListeners(): void {

		this.rawListeners.push(this._raw.onDidInitialize(() => {
			aria.status(nls.localize('debuggingStarted', "Debugging started."));
			const sendConfigurationDone = () => {
				if (this._raw && this._raw.capabilities.supportsConfigurationDoneRequest) {
					return this._raw.configurationDone().then(null, e => {
						// Disconnect the debug session on configuration done error #10596
						if (this._raw) {
							this._raw.disconnect();
						}
						this.notificationService.error(e.message);
					});
				}

				return undefined;
			};

			// Send all breakpoints
			this.debugService.sendAllBreakpoints(this).then(sendConfigurationDone, sendConfigurationDone)
				.then(() => this.fetchThreads());
		}));

		this.rawListeners.push(this._raw.onDidStop(event => {
			this.state = State.Stopped;
			this.fetchThreads(event.body).then(() => {
				const thread = this.getThread(event.body.threadId);
				if (thread) {
					// Call fetch call stack twice, the first only return the top stack frame.
					// Second retrieves the rest of the call stack. For performance reasons #25605
					this.model.fetchCallStack(<Thread>thread).then(() => {
						return !event.body.preserveFocusHint ? this.debugService.tryToAutoFocusStackFrame(thread) : undefined;
					});
				}
			});
		}));

		this.rawListeners.push(this._raw.onDidThread(event => {
			if (event.body.reason === 'started') {
				// debounce to reduce threadsRequest frequency and improve performance
				if (!this.fetchThreadsScheduler) {
					this.fetchThreadsScheduler = new RunOnceScheduler(() => {
						this.fetchThreads();
					}, 100);
					this.rawListeners.push(this.fetchThreadsScheduler);
				}
				if (!this.fetchThreadsScheduler.isScheduled()) {
					this.fetchThreadsScheduler.schedule();
				}
			} else if (event.body.reason === 'exited') {
				this.model.clearThreads(this.getId(), true, event.body.threadId);
			}
		}));

		this.rawListeners.push(this._raw.onDidTerminateDebugee(event => {
			aria.status(nls.localize('debuggingStopped', "Debugging stopped."));
			if (event.body && event.body.restart) {
				this.debugService.restartSession(this, event.body.restart).then(null, err => this.notificationService.error(err.message));
			} else {
				this._raw.disconnect();
			}
		}));

		this.rawListeners.push(this._raw.onDidContinued(event => {
			const threadId = event.body.allThreadsContinued !== false ? undefined : event.body.threadId;
			this.model.clearThreads(this.getId(), false, threadId);
			this.state = State.Running;
		}));

		let outputPromises: TPromise<void>[] = [];
		this.rawListeners.push(this._raw.onDidOutput(event => {
			if (!event.body) {
				return;
			}

			const outputSeverity = event.body.category === 'stderr' ? severity.Error : event.body.category === 'console' ? severity.Warning : severity.Info;
			if (event.body.category === 'telemetry') {
				// only log telemetry events from debug adapter if the debug extension provided the telemetry key
				// and the user opted in telemetry
				if (this._raw.customTelemetryService && this.telemetryService.isOptedIn) {
					// __GDPR__TODO__ We're sending events in the name of the debug extension and we can not ensure that those are declared correctly.
					this._raw.customTelemetryService.publicLog(event.body.output, event.body.data);
				}

				return;
			}

			// Make sure to append output in the correct order by properly waiting on preivous promises #33822
			const waitFor = outputPromises.slice();
			const source = event.body.source ? {
				lineNumber: event.body.line,
				column: event.body.column ? event.body.column : 1,
				source: this.getSource(event.body.source)
			} : undefined;
			if (event.body.variablesReference) {
				const container = new ExpressionContainer(this, event.body.variablesReference, generateUuid());
				outputPromises.push(container.getChildren().then(children => {
					return TPromise.join(waitFor).then(() => children.forEach(child => {
						// Since we can not display multiple trees in a row, we are displaying these variables one after the other (ignoring their names)
						child.name = null;
						this.debugService.logToRepl(child, outputSeverity, source);
					}));
				}));
			} else if (typeof event.body.output === 'string') {
				TPromise.join(waitFor).then(() => this.debugService.logToRepl(event.body.output, outputSeverity, source));
			}
			TPromise.join(outputPromises).then(() => outputPromises = []);
		}));

		this.rawListeners.push(this._raw.onDidBreakpoint(event => {
			const id = event.body && event.body.breakpoint ? event.body.breakpoint.id : undefined;
			const breakpoint = this.model.getBreakpoints().filter(bp => bp.idFromAdapter === id).pop();
			const functionBreakpoint = this.model.getFunctionBreakpoints().filter(bp => bp.idFromAdapter === id).pop();

			if (event.body.reason === 'new' && event.body.breakpoint.source) {
				const source = this.getSource(event.body.breakpoint.source);
				const bps = this.model.addBreakpoints(source.uri, [{
					column: event.body.breakpoint.column,
					enabled: true,
					lineNumber: event.body.breakpoint.line,
				}], false);
				if (bps.length === 1) {
					this.model.updateBreakpoints({ [bps[0].getId()]: event.body.breakpoint });
				}
			}

			if (event.body.reason === 'removed') {
				if (breakpoint) {
					this.model.removeBreakpoints([breakpoint]);
				}
				if (functionBreakpoint) {
					this.model.removeFunctionBreakpoints(functionBreakpoint.getId());
				}
			}

			if (event.body.reason === 'changed') {
				if (breakpoint) {
					if (!breakpoint.column) {
						event.body.breakpoint.column = undefined;
					}
					this.model.setBreakpointSessionData(this.getId(), { [breakpoint.getId()]: event.body.breakpoint });
				}
				if (functionBreakpoint) {
					this.model.setBreakpointSessionData(this.getId(), { [functionBreakpoint.getId()]: event.body.breakpoint });
				}
			}
		}));

		this.rawListeners.push(this._raw.onDidLoadedSource(event => {
			this._onDidLoadedSource.fire({
				reason: event.body.reason,
				source: this.getSource(event.body.source)
			});
		}));

		this.rawListeners.push(this._raw.onDidCustomEvent(event => {
			this._onDidCustomEvent.fire(event);
		}));

		this.rawListeners.push(this._raw.onDidExitAdapter(event => {
			this._onDidEndAdapter.fire(event);
		}));
	}

	dispose(): void {
		dispose(this.rawListeners);
		this.model.clearThreads(this.getId(), true);
		this.model.removeSession(this.getId());
		this.fetchThreadsScheduler = undefined;
		if (this._raw) {
			this._raw.disconnect();
		}
		this._raw = undefined;
	}

	//---- sources

	getSourceForUri(modelUri: uri): Source {
		return this.sources.get(modelUri.toString());
	}

	getSource(raw: DebugProtocol.Source): Source {
		let source = new Source(raw, this.getId());
		if (this.sources.has(source.uri.toString())) {
			source = this.sources.get(source.uri.toString());
			source.raw = mixin(source.raw, raw);
			if (source.raw && raw) {
				// Always take the latest presentation hint from adapter #42139
				source.raw.presentationHint = raw.presentationHint;
			}
		} else {
			this.sources.set(source.uri.toString(), source);
		}

		return source;
	}
}
