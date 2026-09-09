const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 256;

class BoundedText {
  private parts: string[] = [];
  private part: string[] = [];
  private bytes = 0;
  private previousHigh = false;

  append(character: string): void {
    if (this.bytes > MAX_BYTES) return;
    const code = character.charCodeAt(0);
    this.bytes += code < 0x80 ? 1 : code < 0x800 ? 2
      : code >= 0xdc00 && code <= 0xdfff && this.previousHigh ? 1 : 3;
    this.previousHigh = code >= 0xd800 && code <= 0xdbff;
    if (this.bytes > MAX_BYTES) {
      this.parts = [];
      this.part = [];
      return;
    }
    this.part.push(character);
    if (this.part.length === 8192) {
      this.parts.push(this.part.join(""));
      this.part = [];
    }
  }

  value(): string | undefined {
    return this.bytes > MAX_BYTES ? undefined : this.parts.join("") + this.part.join("");
  }
}

type Frame = {
  kind: "object" | "array";
  state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
  key?: string;
  projectedMessages?: boolean;
  lastMessage?: string;
  hasMessage?: boolean;
};

type Capture = { depth: number; key?: string; text: BoundedText };

/** Validate one JSON object, retaining only the last top-level messages item. */
export class PiTerminalJson {
  private frames: Frame[] = [];
  private fields = new Map<string, string | undefined>();
  private fieldBytes = 2;
  private failed = false;
  private started = false;
  private complete = false;
  private capture?: Capture;
  private token?: "string" | "number" | "literal";
  private keyText?: BoundedText;
  private stringIsKey = false;
  private escaped = false;
  private unicodeRemaining = 0;
  private numberState = "";
  private literal = "";
  private literalIndex = 0;

  write(chunk: string): void {
    for (let i = 0; i < chunk.length && !this.failed; i++) this.character(chunk[i]);
  }

  end(): Record<string, unknown> | undefined {
    if (this.token === "number" && this.numberCanEnd()) {
      this.token = undefined;
      this.finishValue();
    }
    if (this.failed || this.token || !this.complete) return undefined;
    const entries: string[] = [];
    for (const [key, value] of this.fields) {
      if (value === undefined) return undefined;
      entries.push(`${JSON.stringify(key)}:${value}`);
    }
    const projected = `{${entries.join(",")}}`;
    if (Buffer.byteLength(projected) > MAX_BYTES) return undefined;
    try { return JSON.parse(projected) as Record<string, unknown>; } catch { return undefined; }
  }

  private character(character: string): void {
    if (this.token === "number") {
      if (this.numberCharacter(character)) {
        this.capture?.text.append(character);
        return;
      }
      if (!this.numberCanEnd()) { this.failed = true; return; }
      this.token = undefined;
      this.finishValue();
    }
    if (this.token === "string") {
      this.capture?.text.append(character);
      this.keyText?.append(character);
      this.stringCharacter(character);
      return;
    }
    if (this.token === "literal") {
      this.capture?.text.append(character);
      if (character !== this.literal[this.literalIndex++]) { this.failed = true; return; }
      if (this.literalIndex === this.literal.length) {
        this.token = undefined;
        this.finishValue();
      }
      return;
    }
    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      this.capture?.text.append(character);
      return;
    }
    if (this.complete) { this.failed = true; return; }
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.started || character !== "{") { this.failed = true; return; }
      this.started = true;
      this.frames.push({ kind: "object", state: "keyOrEnd" });
      return;
    }
    if (character === "}" || character === "]") {
      this.closeContainer(character);
      return;
    }
    if (frame.state === "key" || frame.state === "keyOrEnd") {
      if (character !== '"') { this.failed = true; return; }
      this.capture?.text.append(character);
      this.startString();
      this.stringIsKey = true;
      if (this.frames.length === 1) {
        this.keyText = new BoundedText();
        this.keyText.append(character);
      }
      return;
    }
    if (frame.state === "colon") {
      this.capture?.text.append(character);
      if (character !== ":") { this.failed = true; return; }
      frame.state = "value";
      return;
    }
    if (frame.state === "commaOrEnd") {
      this.capture?.text.append(character);
      if (character !== ",") { this.failed = true; return; }
      frame.state = frame.kind === "object" ? "key" : "value";
      return;
    }
    this.startValue(character, frame);
  }

  private startValue(character: string, frame: Frame): void {
    const projectedMessages = this.frames.length === 1 && frame.key === "messages" && character === "[";
    if (!this.capture && !projectedMessages && (this.frames.length === 1 || frame.projectedMessages)) {
      this.capture = { depth: this.frames.length, key: this.frames.length === 1 ? frame.key : undefined,
        text: new BoundedText() };
    }
    this.capture?.text.append(character);
    if (character === "{" || character === "[") {
      if (this.frames.length >= MAX_DEPTH) { this.failed = true; return; }
      this.frames.push({ kind: character === "{" ? "object" : "array",
        state: character === "{" ? "keyOrEnd" : "valueOrEnd", projectedMessages });
    } else if (character === '"') {
      this.startString();
    } else if (character === "-" || /[0-9]/.test(character)) {
      this.token = "number";
      this.numberState = character === "-" ? "minus" : character === "0" ? "zero" : "integer";
    } else if (character === "t" || character === "f" || character === "n") {
      this.token = "literal";
      this.literal = character === "t" ? "true" : character === "f" ? "false" : "null";
      this.literalIndex = 1;
    } else this.failed = true;
  }

  private startString(): void {
    this.token = "string";
    this.stringIsKey = false;
    this.escaped = false;
    this.unicodeRemaining = 0;
  }

  private stringCharacter(character: string): void {
    if (this.unicodeRemaining) {
      if (!/[0-9a-fA-F]/.test(character)) this.failed = true;
      this.unicodeRemaining--;
    } else if (this.escaped) {
      this.escaped = false;
      if (character === "u") this.unicodeRemaining = 4;
      else if (!'"\\/bfnrt'.includes(character)) this.failed = true;
    } else if (character === "\\") this.escaped = true;
    else if (character === '"') {
      this.token = undefined;
      if (this.stringIsKey) {
        const frame = this.frames.at(-1)!;
        if (this.keyText) {
          const raw = this.keyText.value();
          if (raw === undefined) { this.failed = true; return; }
          frame.key = JSON.parse(raw) as string;
          this.keyText = undefined;
        }
        frame.state = "colon";
      } else this.finishValue();
    } else if (character.charCodeAt(0) < 0x20) this.failed = true;
  }

  private numberCharacter(character: string): boolean {
    const digit = character >= "0" && character <= "9";
    switch (this.numberState) {
      case "minus":
        if (digit) { this.numberState = character === "0" ? "zero" : "integer"; return true; }
        return false;
      case "integer":
        if (digit) return true;
        // Both integer forms may continue with a fraction or exponent.
      case "zero":
        if (character === ".") { this.numberState = "dot"; return true; }
        if (character === "e" || character === "E") { this.numberState = "exponent"; return true; }
        return false;
      case "dot":
        if (digit) { this.numberState = "fraction"; return true; }
        return false;
      case "fraction":
        if (digit) return true;
        if (character === "e" || character === "E") { this.numberState = "exponent"; return true; }
        return false;
      case "exponent":
        if (character === "+" || character === "-") { this.numberState = "exponentSign"; return true; }
        if (digit) { this.numberState = "exponentDigits"; return true; }
        return false;
      case "exponentSign":
        if (digit) { this.numberState = "exponentDigits"; return true; }
        return false;
      case "exponentDigits": return digit;
      default: return false;
    }
  }

  private numberCanEnd(): boolean {
    return ["zero", "integer", "fraction", "exponentDigits"].includes(this.numberState);
  }

  private closeContainer(character: string): void {
    const frame = this.frames.at(-1)!;
    const matching = frame.kind === "object" ? character === "}" : character === "]";
    if (!matching || !["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.state)) {
      this.failed = true;
      return;
    }
    this.capture?.text.append(character);
    this.frames.pop();
    if (frame.projectedMessages) {
      this.storeField("messages", frame.hasMessage
        ? frame.lastMessage === undefined ? undefined : `[${frame.lastMessage}]` : "[]");
    }
    this.finishValue();
  }

  private finishValue(): void {
    const frame = this.frames.at(-1);
    if (this.capture?.depth === this.frames.length) {
      const { key, text } = this.capture;
      if (key !== undefined) this.storeField(key, text.value());
      else if (frame?.projectedMessages) {
        frame.lastMessage = text.value();
        frame.hasMessage = true;
      }
      this.capture = undefined;
    }
    if (frame) frame.state = "commaOrEnd";
    else this.complete = true;
  }

  private storeField(key: string, value: string | undefined): void {
    const previous = this.fields.get(key);
    if (!this.fields.has(key)) this.fieldBytes += Buffer.byteLength(JSON.stringify(key)) + 2;
    this.fieldBytes += Buffer.byteLength(value ?? "") - Buffer.byteLength(previous ?? "");
    if (this.fieldBytes > MAX_BYTES + 1) { this.failed = true; return; }
    this.fields.set(key, value);
  }
}
