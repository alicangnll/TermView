"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TermViewProvider = exports.activate = void 0;
const vscode = require("vscode");
const ansi_up_1 = require("ansi_up");
function activate(context) {
    context.subscriptions.push(TermViewProvider.register(context));
}
exports.activate = activate;
class TermViewProvider {
    static register(context) {
        const provider = new TermViewProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(TermViewProvider.viewType, provider);
        return providerRegistration;
    }
    constructor(context) {
        this.context = context;
    }
    /**
     * Called when our custom editor is opened.
     */
    async resolveCustomTextEditor(document, webviewPanel, _token) {
        // Setup initial content for the webview
        webviewPanel.webview.options = {
            enableScripts: false,
        };
        this.updateWebview(webviewPanel, document);
        // Hook up event handlers so that we can synchronize the webview with the text document.
        //
        // The webview is only updated when the document is initially opened or when it is saved.
        // Use `onDidChangeTextDocument` if you want live updates as the user types.
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                this.updateWebview(webviewPanel, document);
            }
        });
        // Make sure we get rid of the listener when our editor is closed.
        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });
    }
    updateWebview(webviewPanel, document) {
        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);
    }
    getHtmlForWebview(webview, document) {
        const ansiUp = new ansi_up_1.default();
        const text = document.getText();
        // Regex for parsing ANSI sequences
        // Group 1: CSI sequences (e.g., \x1b[...m, \x1b[...K, \x1b[?2004h)
        // Group 2: OSC sequences (e.g., \x1b]0;...\x07) - Non-capturing end marker
        // Group 3: Keypad modes (\x1b=, \x1b>)
        // Group 4: Control characters (\r, \n, \b)
        // Group 5: Text content
        const tokenRegex = /(\x1b\[[0-9;?]*[a-zA-Z])|(\x1b\].*?(?:\x07|\x1b\\))|(\x1b[=>])|([\r\n\b])|([^\x1b\r\n\b]+)/g;
        let linesBuffer = [[]]; // 2D array: lines[y][x] = { char, style }
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
                // Ignored
            }
            else if (controlChar) {
                if (controlChar === '\n') {
                    cursorY++;
                    cursorX = 0;
                    if (!linesBuffer[cursorY])
                        linesBuffer[cursorY] = [];
                }
                else if (controlChar === '\r') {
                    cursorX = 0;
                }
                else if (controlChar === '\b') {
                    cursorX = Math.max(0, cursorX - 1);
                }
            }
            else if (ansiCode) {
                if (ansiCode.endsWith('m')) {
                    // SGR (Select Graphic Rendition) -> Change style
                    currentStyle += ansiCode;
                }
                else if (ansiCode.endsWith('K')) {
                    // Erase in Line
                    const param = ansiCode.match(/\d+/);
                    const mode = param ? parseInt(param[0]) : 0;
                    let line = linesBuffer[cursorY];
                    if (mode === 0) {
                        line.splice(cursorX);
                    }
                    else if (mode === 1) {
                        for (let i = 0; i < cursorX; i++) {
                            if (line[i])
                                line[i] = { char: ' ', style: '' };
                        }
                    }
                    else if (mode === 2) {
                        linesBuffer[cursorY] = [];
                    }
                }
                else if (ansiCode.endsWith('J')) {
                    // Erase in Display
                    const param = ansiCode.match(/\d+/);
                    const mode = param ? parseInt(param[0]) : 0;
                    if (mode === 0) {
                        // Erase from cursor to end of screen
                        linesBuffer[cursorY].splice(cursorX);
                        for (let i = cursorY + 1; i < linesBuffer.length; i++) {
                            linesBuffer[i] = [];
                        }
                    }
                    else if (mode === 2) {
                        // Erase entire screen
                        linesBuffer = [[]];
                        cursorX = 0;
                        cursorY = 0;
                    }
                }
                else if (ansiCode.endsWith('P')) {
                    // Delete Character
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    linesBuffer[cursorY].splice(cursorX, count);
                }
                else if (ansiCode.endsWith('A')) {
                    // Cursor Up
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    cursorY = Math.max(0, cursorY - count);
                }
                else if (ansiCode.endsWith('B')) {
                    // Cursor Down
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    cursorY += count;
                    while (linesBuffer.length <= cursorY)
                        linesBuffer.push([]);
                }
                else if (ansiCode.endsWith('D')) {
                    // Cursor Back 
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    cursorX = Math.max(0, cursorX - count);
                }
                else if (ansiCode.endsWith('C')) {
                    // Cursor Forward
                    const param = ansiCode.match(/\d+/);
                    const count = param ? parseInt(param[0]) : 1;
                    cursorX += count;
                }
            }
            else if (textPart) {
                let line = linesBuffer[cursorY];
                for (const char of textPart) {
                    while (line.length < cursorX) {
                        line.push({ char: ' ', style: '' });
                    }
                    line[cursorX] = { char: char, style: currentStyle };
                    cursorX++;
                }
            }
        }
        // Reconstruct result line by line
        const processedLines = linesBuffer.map(line => {
            let result = '';
            let lastStyle = '';
            for (const cell of line) {
                if (cell.style !== lastStyle) {
                    result += '\x1b[0m' + cell.style; // Reset and apply new
                    lastStyle = cell.style;
                }
                result += cell.char;
            }
            result += '\x1b[0m';
            return ansiUp.ansi_to_html(result);
        });
        const htmlContent = processedLines.join('\n');
        // Helper to inject CSS
        // Using a dark theme friendly background and font style
        return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>
					body {
						font-family: 'Courier New', Courier, monospace;
						background-color: #1e1e1e; /* VS Code data theme background approx */
						color: #cccccc;
						padding: 10px;
						white-space: pre-wrap; /* Preserve whitespace */
					}
                    /* Ensure ANSI colors show up well */
				</style>
			</head>
			<body>
				<div id="content">
					${htmlContent}
				</div>
			</body>
			</html>`;
    }
}
exports.TermViewProvider = TermViewProvider;
TermViewProvider.viewType = 'termview.preview';
//# sourceMappingURL=extension.js.map