import * as vscode from 'vscode';
import AnsiUp from 'ansi_up';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(TermViewProvider.register(context));
}

export class TermViewProvider implements vscode.CustomTextEditorProvider {

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new TermViewProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(TermViewProvider.viewType, provider);
        return providerRegistration;
    }

    private static readonly viewType = 'termview.preview';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    private isUpdatingFromWebview = false;

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: true,
        };
        this.updateWebview(webviewPanel, document, true);

        // Hook up event handlers so that we can synchronize the webview with the text document.
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                if (this.isUpdatingFromWebview) {
                    return; // Skip update if it was triggered by the webview itself
                }
                this.updateWebview(webviewPanel, document, false);
            }
        });

        webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'update':
                    this.isUpdatingFromWebview = true;
                    await this.updateTextDocument(document, message.text);
                    this.isUpdatingFromWebview = false;
                    return;
            }
        });

        // Make sure we get rid of the listener when our editor is closed.
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });
    }

    private updateTextDocument(document: vscode.TextDocument, text: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            text
        );
        return vscode.workspace.applyEdit(edit);
    }

    private updateWebview(webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument, initial: boolean) {
        const htmlContent = this.getAnsiHtml(document);
        if (initial) {
            webviewPanel.webview.html = this.getFullHtml(webviewPanel.webview, htmlContent);
        } else {
            webviewPanel.webview.postMessage({ type: 'updateContent', html: htmlContent });
        }
    }

    private getFullHtml(webview: vscode.Webview, initialContent: string): string {
        return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					body {
						font-family: 'Courier New', Courier, monospace;
						background-color: #1e1e1e;
						color: #cccccc;
						padding: 10px;
						white-space: pre-wrap;
                        outline: none;
					}
                    .line {
                        min-height: 1.2em;
                    }
                    #content {
                        outline: none;
                        word-break: break-all;
                    }
				</style>
			</head>
			<body>
				<div id="content" contenteditable="true">
					${initialContent}
				</div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const content = document.getElementById('content');
                    
                    let debounceTimer;
                    content.addEventListener('input', () => {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            const text = reconstructAnsi();
                            vscode.postMessage({ type: 'update', text });
                        }, 300);
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateContent':
                                if (document.activeElement !== content) {
                                    content.innerHTML = message.html;
                                }
                                break;
                        }
                    });

                    function reconstructAnsi() {
                        const lines = content.querySelectorAll('.line, div');
                        const processedLines = [];
                        
                        if (lines.length === 0) {
                            processedLines.push(processNode(content));
                        } else {
                            lines.forEach(line => {
                                if (line.parentElement === content) {
                                    processedLines.push(processNode(line));
                                }
                            });
                        }
                        
                        return processedLines.join('\\n');
                    }

                    function processNode(node) {
                        let text = '';
                        node.childNodes.forEach(child => {
                            if (child.nodeType === Node.ELEMENT_NODE) {
                                if (child.tagName === 'SPAN') {
                                    const dataAnsi = child.getAttribute('data-ansi');
                                    if (dataAnsi) text += dataAnsi.replace(/\\\\x1b/g, '\\x1b');
                                    text += child.innerText;
                                    if (dataAnsi) text += '\\x1b[0m';
                                } else if (child.tagName === 'BR') {
                                    // line break
                                } else {
                                    text += processNode(child);
                                }
                            } else if (child.nodeType === Node.TEXT_NODE) {
                                text += child.textContent;
                            }
                        });
                        return text;
                    }
                </script>
			</body>
			</html>`;
    }

    private getAnsiHtml(document: vscode.TextDocument): string {
        const ansiUp = new AnsiUp();
        const text = document.getText();

        const tokenRegex = /(\x1b\[[0-9;?]*[a-zA-Z])|(\x1b\].*?(?:\x07|\x1b\\))|(\x1b[=>])|([\r\n\b])|([^\x1b\r\n\b]+)/g;

        let linesBuffer: { char: string, style: string }[][] = [[]];
        let cursorX = 0;
        let cursorY = 0;
        let currentStyle = '';

        let match;
        tokenRegex.lastIndex = 0;
        while ((match = tokenRegex.exec(text)) !== null) {
            const ansiCode = match[1];
            const oscSequence = match[2];
            const keypadMode = match[3];
            const controlChar = match[4];
            const textPart = match[5];

            if (oscSequence || keypadMode) {
            } else if (controlChar) {
                if (controlChar === '\n') {
                    cursorY++;
                    cursorX = 0;
                    if (!linesBuffer[cursorY]) linesBuffer[cursorY] = [];
                } else if (controlChar === '\r') {
                    cursorX = 0;
                } else if (controlChar === '\b') {
                    cursorX = Math.max(0, cursorX - 1);
                }
            } else if (ansiCode) {
                if (ansiCode.endsWith('m')) {
                    if (ansiCode === '\x1b[0m') currentStyle = '';
                    else currentStyle += ansiCode;
                } else if (ansiCode.endsWith('K')) {
                    const param = ansiCode.match(/\d+/);
                    const mode = param ? parseInt(param[0]) : 0;
                    let line = linesBuffer[cursorY];
                    if (mode === 0) line.splice(cursorX);
                    else if (mode === 1) {
                        for (let i = 0; i < cursorX; i++) {
                            if (line[i]) line[i] = { char: ' ', style: '' };
                        }
                    } else if (mode === 2) linesBuffer[cursorY] = [];
                } else if (ansiCode.endsWith('J')) {
                    const param = ansiCode.match(/\d+/);
                    const mode = param ? parseInt(param[0]) : 0;
                    if (mode === 0) {
                        linesBuffer[cursorY].splice(cursorX);
                        for (let i = cursorY + 1; i < linesBuffer.length; i++) linesBuffer[i] = [];
                    } else if (mode === 2) {
                        linesBuffer = [[]];
                        cursorX = 0;
                        cursorY = 0;
                    }
                } else if (ansiCode.endsWith('P')) {
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    linesBuffer[cursorY].splice(cursorX, count);
                } else {
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    if (ansiCode.endsWith('A')) cursorY = Math.max(0, cursorY - count);
                    else if (ansiCode.endsWith('B')) {
                        cursorY += count;
                        while (linesBuffer.length <= cursorY) linesBuffer.push([]);
                    }
                    else if (ansiCode.endsWith('D')) cursorX = Math.max(0, cursorX - count);
                    else if (ansiCode.endsWith('C')) cursorX += count;
                }
            } else if (textPart) {
                let line = linesBuffer[cursorY];
                for (const char of textPart) {
                    while (line.length < cursorX) line.push({ char: ' ', style: '' });
                    line[cursorX] = { char: char, style: currentStyle };
                    cursorX++;
                }
            }
        }

        return linesBuffer.map(line => {
            let lineHtml = '';
            let currentSpanAnsi = '';
            let currentSpanText = '';

            const flushSpan = () => {
                if (currentSpanText) {
                    const escapedText = currentSpanText
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');

                    let styleAttr = '';
                    if (currentSpanAnsi) {
                        const styledSnippet = ansiUp.ansi_to_html('\x1b[0m' + currentSpanAnsi + 'X' + '\x1b[0m');
                        const styleMatch = styledSnippet.match(/style="([^"]+)"/);
                        if (styleMatch) styleAttr = styleMatch[1];
                    }

                    const dataAnsiAttr = currentSpanAnsi ? ` data-ansi="${currentSpanAnsi.replace(/\x1b/g, '\\x1b')}"` : '';
                    lineHtml += `<span${styleAttr ? ` style="${styleAttr}"` : ''}${dataAnsiAttr}>${escapedText}</span>`;
                    currentSpanText = '';
                }
            };

            for (const cell of line) {
                if (cell.style !== currentSpanAnsi) {
                    flushSpan();
                    currentSpanAnsi = cell.style;
                }
                currentSpanText += cell.char;
            }
            flushSpan();
            return `<div class="line">${lineHtml || '<br>'}</div>`;
        }).join('');
    }
}
