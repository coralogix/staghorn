# Known limitations

These are the things staghorn deliberately does not do, and the environments where it
needs help. All of them are better known up front than discovered at 6pm.

## Safari

Safari does not implement the `*.localhost` rule, so the hostnames will not resolve.

Either use another browser, or set a tld that has real DNS behind it:

```ts
export default defineConfig({ tld: 'localtest.me' });
```

`localtest.me` is a public wildcard DNS name that points at `127.0.0.1`, needs no setup,
and works everywhere. Note that it requires internet access and is **not** a secure
context, so `Secure` cookies and service workers will not behave as they do on
`*.localhost`.

## HTTPS

Dev stays plain HTTP, which is fine because `*.localhost` is already a secure context as
far as the browser is concerned.

If your app genuinely needs TLS - WebAuthn, or an identity provider that refuses
`http://` redirect URIs - supply your own certificate from
[mkcert](https://github.com/FiloSottile/mkcert). staghorn will never generate
certificates or install a certificate authority into your trust store. Putting a root CA
into someone's keychain is not a thing a dev convenience should do silently.

## Fixed-origin OAuth redirects

An identity provider registers one redirect URI forever, which no per-branch hostname
can satisfy.

Point the provider at the fixed origin your dev server also listens on
(`http://localhost:<port>/callback`, the `direct` rung), complete the flow there, then
continue on the branch hostname. Both are loopback origins, so a session cookie scoped to
the tld is visible to each.

A claimable fixed alias is a likely future addition.

## Corporate proxies

If `HTTP_PROXY` is set, add `*.localhost` to `NO_PROXY` or your browser will send dev
requests to the corporate proxy. `staghorn doctor` detects this and says so.

## Platform support

| | |
| --- | --- |
| **macOS** | Fully supported. Portless by default. |
| **Linux** | Fully supported. Shared port by default; portless with a sysctl. |
| **Windows** | Supported, less exercised. Ports below 1024 are not restricted, so portless often works; `http.sys`/IIS may own `:80`, in which case the shared port is used. |
| **Containers, WSL2** | Works with explicit configuration. Run `staghorn doctor`. |
