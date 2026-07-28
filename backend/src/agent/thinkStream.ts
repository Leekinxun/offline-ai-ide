const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export class ThinkStreamSplitter {
  private buffer = "";
  private inThinking = false;

  constructor(
    private readonly onContent: (value: string) => void,
    private readonly onThinking: (value: string) => void
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    this.drain(false);
  }

  flush(): void {
    this.drain(true);
  }

  private drain(flush: boolean): void {
    while (this.buffer) {
      const tag = this.inThinking ? CLOSE_TAG : OPEN_TAG;
      const index = this.buffer.indexOf(tag);
      if (index >= 0) {
        this.emit(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + tag.length);
        this.inThinking = !this.inThinking;
        continue;
      }

      const retained = flush ? 0 : longestTagPrefixSuffix(this.buffer, tag);
      const emitLength = this.buffer.length - retained;
      if (emitLength > 0) {
        this.emit(this.buffer.slice(0, emitLength));
        this.buffer = this.buffer.slice(emitLength);
      }
      break;
    }
  }

  private emit(value: string): void {
    if (!value) return;
    if (this.inThinking) this.onThinking(value);
    else this.onContent(value);
  }
}

function longestTagPrefixSuffix(value: string, tag: string): number {
  const max = Math.min(value.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

