<template>
    <div class="shadow-box">
        <div v-pre ref="terminal" class="main-terminal"></div>
    </div>
</template>

<script>
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_COLS, TERMINAL_ROWS } from "../../../common/util-common";

export default {
    /**
     * @type {Terminal}
     */
    terminal: null,
    components: {

    },
    props: {
        name: {
            type: String,
            require: true,
        },

        endpoint: {
            type: String,
            require: true,
        },

        // Require if mode is interactive
        stackName: {
            type: String,
        },

        // Require if mode is interactive
        serviceName: {
            type: String,
        },

        // Require if mode is interactive
        shell: {
            type: String,
            default: "bash",
        },

        rows: {
            type: Number,
            default: TERMINAL_ROWS,
        },

        cols: {
            type: Number,
            default: TERMINAL_COLS,
        },

        // Mode
        // displayOnly: Only display terminal output
        // mainTerminal: Allow input limited commands and output
        // interactive: Free input and output
        mode: {
            type: String,
            default: "displayOnly",
        }
    },
    emits: [ "has-data" ],
    data() {
        return {
            first: true,
            terminalInputBuffer: "",
            cursorPosition: 0,
        };
    },
    created() {

    },
    mounted() {
        let cursorBlink = true;

        if (this.mode === "displayOnly") {
            cursorBlink = false;
        }

        this.terminal = new Terminal({
            fontSize: 14,
            fontFamily: "'JetBrains Mono', monospace",
            cursorBlink,
            cols: this.cols,
            rows: this.rows,
        });

        if (this.mode === "mainTerminal") {
            this.mainTerminalConfig();
        } else if (this.mode === "interactive") {
            this.interactiveTerminalConfig();
        }

        //this.terminal.loadAddon(new WebLinksAddon());

        // Bind to a div
        this.terminal.open(this.$refs.terminal);
        // Fallback HTTP: listener paste en textarea interno de xterm
        const xtermTextarea = this.$refs.terminal?.querySelector("textarea.xterm-helper-textarea");
        if (xtermTextarea) {
            xtermTextarea.addEventListener("paste", (event) => {
                if (window.isSecureContext) return; // Solo en HTTP
                event.preventDefault();
                const text = (event.clipboardData || window.clipboardData)?.getData("text");
                if (text) {
                    this.pasteText(text);
                }
            });
        }
        this.terminal.focus();

        // Add right-click context menu handler for paste
        this.$refs.terminal.addEventListener('contextmenu', this.handleContextMenu);

        // Add selection handler for copy to clipboard
        this.terminal.onSelectionChange(() => {
            this.handleSelection();
        });

        // Notify parent component when data is received
        this.terminal.onCursorMove(() => {
            console.debug("onData triggered");
            if (this.first) {
                this.$emit("has-data");
                this.first = false;
            }
        });

        this.bind();

        // Create a new Terminal
        if (this.mode === "mainTerminal") {
            this.$root.emitAgent(this.endpoint, "mainTerminal", this.name, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        } else if (this.mode === "interactive") {
            console.debug("Create Interactive terminal:", this.name);
            this.$root.emitAgent(this.endpoint, "interactiveTerminal", this.stackName, this.serviceName, this.shell, (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                }
            });
        }
        // Fit the terminal width to the div container size after terminal is created.
        this.updateTerminalSize();
    },

    unmounted() {
        window.removeEventListener("resize", this.onResizeEvent); // Remove the resize event listener from the window object.
        this.$root.unbindTerminal(this.name);
        this.terminal.dispose();
        this.$refs.terminal?.removeEventListener('contextmenu', this.handleContextMenu);
    },

    methods: {
        bind(endpoint, name) {
            // Workaround: normally this.name should be set, but it is not sometimes, so we use the parameter, but eventually this.name and name must be the same name
            if (name) {
                this.$root.unbindTerminal(name);
                this.$root.bindTerminal(endpoint, name, this.terminal);
                console.debug("Terminal bound via parameter: " + name);
            } else if (this.name) {
                this.$root.unbindTerminal(this.name);
                this.$root.bindTerminal(this.endpoint, this.name, this.terminal);
                console.debug("Terminal bound: " + this.name);
            } else {
                console.debug("Terminal name not set");
            }
        },

        removeInput() {
            const textAfterCursorLength = this.terminalInputBuffer.length - this.cursorPosition;
            const spaces = " ".repeat(textAfterCursorLength);
            const backspaceCount = this.terminalInputBuffer.length;
            const backspaces = "\b \b".repeat(backspaceCount);
            this.cursorPosition = 0;
            this.terminal.write(spaces + backspaces);
            this.terminalInputBuffer = "";
        },

        clearCurrentLine() {
            // Move cursor to the beginning of the input and clear it
            const backspaces = "\b".repeat(this.cursorPosition);
            const spaces = " ".repeat(this.terminalInputBuffer.length);
            const moreBackspaces = "\b".repeat(this.terminalInputBuffer.length);
            this.terminal.write(backspaces + spaces + moreBackspaces);
        },

        mainTerminalConfig() {
            this.terminal.onKey(e => {
                // Optional: keep for debugging
                // console.debug("Encode: " + JSON.stringify(e.key));

                if (e.key === "\r") {
                    // Return if no input
                    if (this.terminalInputBuffer.length === 0) {
                        return;
                    }

                    const buffer = this.terminalInputBuffer;

                    // Remove the input from the terminal
                    this.removeInput();

                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, buffer + e.key, (err) => {
                        this.$root.toastError(err.msg);
                    });
                } else if (e.key === "\u007F") {      // Backspace
                    if (this.cursorPosition > 0) {
                        // Remove character to the left of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition - 1);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                        this.terminalInputBuffer = beforeCursor + afterCursor;
                        this.cursorPosition--;
                        
                        // Redraw the line
                        this.terminal.write("\b" + afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B\u005B\u0033\u007E") { // Delete key
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        // Remove character to the right of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition + 1);
                        this.terminalInputBuffer = beforeCursor + afterCursor;
                        
                        // Redraw the line from cursor position
                        this.terminal.write(afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B\u005B\u0041" || e.key === "\u001B\u005B\u0042") {      // UP OR DOWN
                    // Do nothing
                } else if (e.key === "\u001B\u005B\u0043") {      // RIGHT
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        this.terminal.write(this.terminalInputBuffer[this.cursorPosition]);
                        this.cursorPosition++;
                    }
                } else if (e.key === "\u001B\u005B\u0044") {      // LEFT
                    if (this.cursorPosition > 0) {
                        this.terminal.write("\b");
                        this.cursorPosition--;
                    }
                } else if (e.key === "\u0003") {      // Ctrl + C
                    console.debug("Ctrl + C");
                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, e.key);
                    this.removeInput();
                } else if (e.key === "\u0016" || (e.domEvent?.ctrlKey && e.key.toLowerCase() === "v")) {      // Ctrl + V
                    this.handlePaste();
                } else if (e.key === "\u0009" || e.key.startsWith("\u001B")) {      // TAB or other special keys
                    // Do nothing
                } else {
                    const textBeforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                    const textAfterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                    this.terminalInputBuffer = textBeforeCursor + e.key + textAfterCursor;
                    this.terminal.write(e.key + textAfterCursor + "\b".repeat(textAfterCursor.length));
                    this.cursorPosition++;
                }
            });
        },

        interactiveTerminalConfig() {
            this.terminal.onKey(e => {
                // Handle Ctrl+V for paste
                if (e.key === "\u0016" || (e.domEvent?.ctrlKey && e.key.toLowerCase() === "v")) {
                    this.handlePaste();
                    return;
                }

                this.$root.emitAgent(this.endpoint, "terminalInput", this.name, e.key, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            });
        },

        /**
         * Update the terminal size to fit the container size.
         *
         * If the terminalFitAddOn is not created, creates it, loads it and then fits the terminal to the appropriate size.
         * It then addes an event listener to the window object to listen for resize events and calls the fit method of the terminalFitAddOn.
         */
        updateTerminalSize() {
            if (!Object.hasOwn(this, "terminalFitAddOn")) {
                this.terminalFitAddOn = new FitAddon();
                this.terminal.loadAddon(this.terminalFitAddOn);
                window.addEventListener("resize", this.onResizeEvent);
            }
            this.terminalFitAddOn.fit();
        },
        /**
         * Handles the resize event of the terminal component.
         */
        onResizeEvent() {
            this.terminalFitAddOn.fit();
            let rows = this.terminal.rows;
            let cols = this.terminal.cols;
            this.$root.emitAgent(this.endpoint, "terminalResize", this.name, rows, cols);
        },

        /**
         * Handle clipboard paste operation
         */
        async handlePaste() {
            // Método 1: navigator.clipboard (solo HTTPS/localhost)
            if (navigator.clipboard && window.isSecureContext) {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        this.pasteText(text);
                    }
                    return;
                } catch (error) {
                    console.debug("clipboard API no disponible:", error);
                }
            }

            // Método 2: Fallback HTTP
            // Leer directamente del textarea interno de xterm
            const xtermTextarea = this.$refs.terminal?.querySelector("textarea.xterm-helper-textarea");
            if (xtermTextarea) {
                xtermTextarea.focus();
                document.execCommand("paste");
            }
        },

        /**
         * Paste text into the terminal based on current mode
         */
        pasteText(text) {
            if (this.mode === "mainTerminal") {
                // For main terminal, insert text at current cursor position
                const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                
                // Update the buffer with inserted text
                this.terminalInputBuffer = beforeCursor + text + afterCursor;
                
                // Clear the current line and rewrite it
                this.clearCurrentLine();
                this.terminal.write(this.terminalInputBuffer);
                
                // Move cursor to the correct position (after the pasted text)
                this.cursorPosition += text.length;
                const backspaces = "\b".repeat(afterCursor.length);
                this.terminal.write(backspaces);
                
            } else if (this.mode === "interactive") {
                // For interactive terminal, send directly to server
                this.$root.emitAgent(this.endpoint, "terminalInput", this.name, text, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            }
        },

        /**
         * Handle right-click context menu for paste operation
         */
        handleContextMenu(event) {
            // Prevent default context menu
            event.preventDefault();
            
            // Only handle paste for modes that support input
            if (this.mode === "mainTerminal" || this.mode === "interactive") {
                this.handlePaste();
            }
        },

        /**
         * Handle text selection in terminal - copy to clipboard
         */
        handleSelection() {
            const selectedText = this.terminal.getSelection();
            if (selectedText && selectedText.length > 0) {
                this.copyToClipboard(selectedText);
            }
        },

        /**
         * Copy text to clipboard
         */
        async copyToClipboard(text) {
            // Método 1: navigator.clipboard (solo HTTPS/localhost)
            if (navigator.clipboard && window.isSecureContext) {
                try {
                    await navigator.clipboard.writeText(text);
                    console.debug("Text copied to clipboard:", text);
                    return;
                } catch (error) {
                    console.debug("clipboard API no disponible:", error);
                }
            }

            // Método 2: Fallback HTTP con execCommand
            try {
                const textarea = document.createElement("textarea");
                textarea.value = text;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                document.body.removeChild(textarea);
                console.debug("Text copied via fallback:", text);
            } catch (error) {
                console.error("Failed to copy to clipboard:", error);
            }
        },
    }
};
</script>

<style scoped lang="scss">
.main-terminal {
    height: 100%;
}
</style>

<style lang="scss">
.terminal {
    background-color: black !important;
    height: 100%;
}
</style>
