declare module 'http2-proxy' {
  import * as Http from 'http';
  import * as Http2 from 'http2';
  import * as Net from 'net';
  import * as Tls from 'tls';

  // Http-web
  export function web<_req extends Http.IncomingMessage, _res extends Http.ServerResponse>(
    req: _req,
    res: _res,
    options: webOptionsUnsecure,
    callback?: (
      err: Error,
      req: _req,
      res: _res
    ) => void
  ): Promise<void>;

  // Http2-web
  export function web<_req extends Http2.Http2ServerRequest, _res extends Http2.Http2ServerResponse>(
    req: _req,
    res: _res,
    options: webOptionsSecure,
    callback?: (
      err: Error,
      req: _req,
      res: _res
    ) => void
  ): Promise<void>;

  //Ws-http
  export function ws<_req extends Http.IncomingMessage>(
    req: _req,
    socket: Net.Socket,
    head: Buffer,
    options: wsOptionsUnsecure,
    callback?: (
      err: Error,
      req: _req,
      socket: Net.Socket,
      head: Buffer
    ) => void
  ): Promise<void>;

  // Ws-http2
  export function ws<_req extends Http2.Http2ServerRequest>(
    req: _req,
    socket: Tls.TLSSocket,
    head: Buffer,
    options: wsOptionsSecure,
    callback?: (
      err: Error,
      req: _req,
      socket: Tls.TLSSocket,
      head: Buffer
    ) => void
  ): Promise<void>;


  interface optionsSecure extends Tls.ConnectionOptions {
    timeout?: number;
    hostname: string;
    port: number;
    protocol?: 'https';
    path?: string;
    proxyTimeout?: number;
    proxyName?: string;
    socketPath?: string;

    onReq?(
      req: Http2.Http2ServerRequest,
      options: Http.RequestOptions,
      callback: (err?: Error) => void
    ): Promise<void | Http.ClientRequest>;
  }

  interface optionsUnsecure extends Net.ConnectOpts {
    timeout?: number;
    hostname: string;
    port: number;
    protocol?: 'http' | 'https';
    path?: string;
    proxyTimeout?: number;
    proxyName?: string;
    socketPath?: string;

    onReq?(
      req: Http.IncomingMessage,
      options: Http.RequestOptions,
      callback: (err?: Error) => void
    ): Promise<void | Http.ClientRequest>;
  }

  interface webOptionsSecure extends optionsSecure {
    onRes?(
      req: Http2.Http2ServerRequest,
      res: Http2.Http2ServerResponse,
      proxyRes: Http.ServerResponse,
      callback: (err?: Error) => any
    ): Promise<void>;
  }

  interface webOptionsUnsecure extends optionsUnsecure {
    onRes?(
      req: Http.IncomingMessage,
      res: Http.ServerResponse,
      proxyRes: Http.ServerResponse,
      callback: (err?: Error) => any
    ): Promise<void>;
  }

  interface wsOptionsSecure extends optionsSecure {
    onRes?(
      req: Http2.Http2ServerRequest,
      socket: Tls.TLSSocket,
      proxyRes: Http.ServerResponse,
      callback: (err?: Error) => any
    ): Promise<void>;
  }

  interface wsOptionsUnsecure extends optionsUnsecure {
    onRes?(
      req: Http.IncomingMessage,
      socket: Net.Socket,
      proxyRes: Http.ServerResponse,
      callback: (err?: Error) => any
    ): Promise<void>;
  }
}
