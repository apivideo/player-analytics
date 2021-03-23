import md5 from 'md5';
import 'whatwg-fetch';

const PLAYBACK_PING_DELAY = 10 * 1000;

export type PlayerAnalyticsOptions = WithCustomOptions | WithMediaUrl;

type WithCustomOptions = CustomOptions & CommonOptions;

type CustomOptions = {
    videoType: 'live' | 'vod';
    videoId: string;
    pingUrl: string;
};

type WithMediaUrl = {
    mediaUrl: string;
} & CommonOptions;

export type CommonOptions = {
    userMetadata?: { [name: string]: string }[];
    sequence?: {
        start: number;
        end?: number;
    };
    onSessionIdReceived?: (sessionId: string) => void;
}

type PingEvent = {
    emitted_at: string;
    type: EventName;
    at?: number;
    from?: number;
    to?: number;
}

type PlaybackPingMessage = {
    emitted_at: string;
    session: {
        loaded_at: string;
        video_id?: string;
        live_stream_id?: string;
        referrer: string;
        metadata?: { [name: string]: string }[];
        session_id?: string;
        navigator?: NavigatorSettings;
    }
    events: PingEvent[];
};

type EventName =
    'play' |
    'resume' |
    'ready' |
    'pause' |
    'end' |
    'seek.forward' |
    'seek.backward'

type NavigatorSettings = {
    user_agent: string;
    connection: any;
    timing?: any,
}

export const isWithMediaUrl = (options: PlayerAnalyticsOptions): options is WithMediaUrl => {
    return !!(options as WithMediaUrl).mediaUrl;
}

export const isWithCustomOptions = (options: PlayerAnalyticsOptions): options is WithCustomOptions => {
    const asWithCustomOptions = options as WithCustomOptions;
    return !!asWithCustomOptions.pingUrl
        && !!asWithCustomOptions.videoId
        && !!asWithCustomOptions.videoType;
}


export class PlayerAnalytics {
    protected sessionId?: string;
    protected options: WithCustomOptions;
    protected sessionIdStorageKey: string;
    protected fetchFunc: ((input: RequestInfo, init?: RequestInit) => Promise<Response>) | undefined = undefined;
    private loadedAt = new Date();
    private eventsStack: PingEvent[] = [];
    private alreadySentEvents = 0;
    private currentTime: number = 0;
    private pingsSendPaused: boolean;
    private pingInterval: number;

    constructor(options: WithCustomOptions | WithMediaUrl) {
        if (!isWithCustomOptions(options) && !isWithMediaUrl(options)) {
            throw new Error('Option must contains mediaUrl or pingUrl, videoId and videoType');
        }
        if (isWithMediaUrl(options)) {
            this.options = {
                ...options,
                ...this.parseMediaUrl(options.mediaUrl),
            }
        } else {
            this.options = options;
        }

        this.pingsSendPaused = true;
        this.sessionIdStorageKey = PlayerAnalytics.generateSessionIdStorageKey(this.options.videoId);

        const sessionIdFromLocalStorage = window.sessionStorage.getItem(this.sessionIdStorageKey);
        if (sessionIdFromLocalStorage) {
            this.setSessionId(sessionIdFromLocalStorage);
        }

        this.pingInterval = window.setInterval(() => {
            if (!this.pingsSendPaused) {
                this.sendPing(this.buildPingPayload());
            }
        }, PLAYBACK_PING_DELAY);
    }

    protected static generateSessionIdStorageKey(videoId: string) {
        return `apivideo_session_id_${md5(videoId).substring(0, 16)}`;
    }

    public play(): Promise<void> {
        this.pingsSendPaused = false;
        return this.pushRegularEvent('play')
    }

    public resume(): Promise<void> {
        this.pingsSendPaused = false;
        return this.pushRegularEvent('resume')
    }

    public ready(): Promise<void> {
        this.pushRegularEvent('ready');
        return this.sendPing(this.buildPingPayload()).then(a => undefined);
    }

    public end(): Promise<void> {
        this.pingsSendPaused = true;
        this.pushRegularEvent('end');
        return this.sendPing(this.buildPingPayload()).then(a => undefined);
    }

    public seek(from: number, to: number): Promise<void> {
        this.pushEvent({
            type: from < to ? 'seek.forward' : 'seek.backward',
            from,
            to,
            emitted_at: new Date().toISOString()
        })
        return new Promise((resolve, reject) => resolve());
    }

    public pause(): Promise<void> {
        this.pingsSendPaused = true;
        this.pushRegularEvent('pause')
        return this.sendPing(this.buildPingPayload()).then(a => undefined);
    }

    public destroy(): Promise<void> {
        clearInterval(this.pingInterval);
        return this.pause();
    }

    public updateTime(time: number): Promise<void> {
        this.currentTime = time;
        return new Promise((resolve, reject) => resolve());
    }

    public pushEvent(event: PingEvent) {
        this.eventsStack.push(event);
    }

    protected parseMediaUrl(mediaUrl: string): CustomOptions {
        const re = /https:\/.*[\/](vod|live)([\/]|[\/\.][^\/]*[\/])([^\/^\.]*)[\/\.].*/gm;
        const parsed = re.exec(mediaUrl);

        if (!parsed || parsed.length < 3 || !parsed[1] || !parsed[3]) {
            throw new Error("The media url doesn't look like an api.video URL.");
        }
        if (['vod', 'live'].indexOf(parsed[1]) === -1) {
            throw new Error("Can't termine if media URL is vod or live.");
        }

        const videoType = parsed[1] as 'vod' | 'live';
        const videoId = parsed[3];

        return {
            pingUrl: 'https://collector.api.video/${type}'.replace('${type}', videoType),
            videoId,
            videoType,
        }

    }

    private pushRegularEvent(eventName: Exclude<EventName, 'seek.forward' | 'seek.backward'>): Promise<void> {
        this.pushEvent({
            type: eventName,
            emitted_at: new Date().toISOString(),
            at: this.currentTime
        })
        return new Promise((resolve, reject) => resolve());
    }

    private buildPingPayload(): PlaybackPingMessage {
        return {
            emitted_at: new Date().toISOString(),
            session: {
                loaded_at: this.loadedAt.toISOString(),
                referrer: document.referrer,
                metadata: this.options.userMetadata || [],
                ...(this.sessionId && { session_id: this.sessionId }),
                ...(this.options.videoType === 'live' && { live_stream_id: this.options.videoId }),
                ...(this.options.videoType === 'vod' && { video_id: this.options.videoId }),
            },
            events: this.eventsStack.slice(this.alreadySentEvents)
        };
    }

    private sendPing(payload: PlaybackPingMessage): Promise<Response | void> {
        if (!this.options.pingUrl) {
            return Promise.resolve();
        }
        this.alreadySentEvents = this.eventsStack.length;

        const fetchPromise = (this.fetchFunc || fetch)(this.options.pingUrl + '?t=' + new Date().getTime(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        return fetchPromise
            .then(response => response.json())
            .then(data => {
                if (data.session && !this.sessionId) {
                    this.setSessionId(data.session);
                }
                return data;
            });
    }


    private setSessionId(sessionId: string): void {
        if (!sessionId) return;

        this.sessionId = sessionId

        if (this.options.onSessionIdReceived) {
            this.options.onSessionIdReceived(sessionId);
        }

        try {
            window.sessionStorage.setItem(this.sessionIdStorageKey, this.sessionId);
        } catch (e) {
            // enmpty
        }
    }

}