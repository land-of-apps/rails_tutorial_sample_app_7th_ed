export type HistoryItem = {
  message: string;
  error?: string;
};

export default class History {
  items = new Array<HistoryItem>();

  push(item: HistoryItem) {
    this.items.push(item);
  }

  failed(error: string) {
    this.items[this.items.length - 1].error = error;
  }

  messages(limit?: number): string[] {
    const items = limit ? this.items.slice(-limit) : this.items;
    return items.map((item) => {
      const message = [item.message];
      if (item.error) message.push(`failed with error: ${item.error}`);
      return message.join(', ');
    });
  }
}
