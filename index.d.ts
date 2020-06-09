declare module 'http2-proxy' {
    import * as http from 'http';
    import * as http2 from 'http2';
    import * as Net from 'net';
    import * as tls from 'tls';
    export function web(
        req: http.IncomingMessage | http2.Http2ServerRequest,
        res: http.ServerResponse | http2.Http2ServerResponse,
        options: webOptions,
        callback?: (
            err: Error,
            req: http.IncomingMessage | http2.Http2ServerRequest,
            res: http.ServerResponse | http2.Http2ServerResponse
        ) => void
    ): Promise<void>;

    export function ws(
        req: http.IncomingMessage | http2.Http2ServerRequest,
        socket: Net.Socket | tls.TLSSocket,
        head: Buffer,
        options: wsOptions,
        callback?: (
            err: Error,
            req: http.IncomingMessage | http2.Http2ServerRequest,
            socket: Net.Socket | tls.TLSSocket,
            head: Buffer
        ) => void
    ): Promise<void>;

    interface options extends tls.ConnectionOptions {
        timeout?: number;
        hostname: string;
        port: number;
        protocol?: 'http' | 'https';
        path?: string;
        proxyTimeout?: number;
        proxyName?: string;
        socketPath?: string;
        onReq?(
            req: http.IncomingMessage | http2.Http2ServerRequest,
            options: http.RequestOptions,
            callback: (err?: Error) => void
        ): Promise<void | http.ClientRequest>;
    }

    interface webOptions extends options {
        onRes?(
            req: http.IncomingMessage | http2.Http2ServerRequest,
            res: http.ServerResponse | http2.Http2ServerResponse,
            proxyRes: http.ServerResponse,
            callback: (err?: Error) => any
        ): Promise<void>;
    }

    interface wsOptions extends options {
        onRes?(
            req: http.IncomingMessage | http2.Http2ServerRequest,
            socket: Net.Socket | tls.TLSSocket,
            proxyRes: http.ServerResponse,
            callback: (err?: Error) => any
        ): Promise<void>;
    }
}
