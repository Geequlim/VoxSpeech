export class ModelDownloadError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class DownloadLockedError extends ModelDownloadError {}

export class DownloadIntegrityError extends ModelDownloadError {}

export class DownloadAbortedError extends ModelDownloadError {}
