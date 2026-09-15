// 新規セッション・名前を変更・確認のダイアログ（§6.6・§6.12）。

import { App, Modal, Setting, TextComponent } from "obsidian";

/** 新規セッション：名前 1 行と「開始」。Enter でも開始。 */
export class NewSessionModal extends Modal {
	private textComponent!: TextComponent;

	constructor(
		app: App,
		private onSubmit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("新規セッション");
		new Setting(this.contentEl).setName("名前").addText((text) => {
			this.textComponent = text;
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("開始")
				.setCta()
				.onClick(() => this.submit())
		);
		window.setTimeout(() => this.textComponent.inputEl.focus(), 0);
	}

	private submit(): void {
		this.onSubmit(this.textComponent.getValue().trim());
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 名前を変更：現在の名前を入れた 1 行。Enter でも変更。 */
export class RenameSessionModal extends Modal {
	private textComponent!: TextComponent;

	constructor(
		app: App,
		private currentName: string,
		private onSubmit: (name: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("名前を変更");
		new Setting(this.contentEl).setName("名前").addText((text) => {
			this.textComponent = text;
			text.setValue(this.currentName);
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("変更")
				.setCta()
				.onClick(() => this.submit())
		);
		window.setTimeout(() => {
			this.textComponent.inputEl.focus();
			this.textComponent.inputEl.select();
		}, 0);
	}

	private submit(): void {
		const value = this.textComponent.getValue().trim();
		if (value) {
			this.onSubmit(value);
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 確認して実行する（セッションを終了、など）。 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("キャンセル").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.onConfirm();
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
