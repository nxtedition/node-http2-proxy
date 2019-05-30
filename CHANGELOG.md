# 5.0.0

* Internal rewrite.
* Pass hop by hop processed headers to onReq callback.
* 503 error is guaranteed to not have written anything to res. This is useful for proxies which want to be able to retry against other upstream server.
* onRes and onReq can now return a promise (callback is optional in Legacy API).
