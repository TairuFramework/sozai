# Test vector attribution

The JSON files in `input/` and `output/` are the official RFC 8785 (JSON Canonicalization
Scheme) test vectors, copied verbatim from the `testdata/` directory of:

https://github.com/cyberphone/json-canonicalization

Copyright 2018 Anders Rundgren, licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0

These fixtures are the only Apache-2.0 material in this package. `src/` is original work written
against RFC 8785 and is MIT licensed, like the rest of this repository.

Not included: the ES6 number test vector, a 100-million-line file distributed as a release
artifact. Number serialization here is delegated wholesale to `JSON.stringify`, which is
specified to produce exactly the format the RFC requires.
