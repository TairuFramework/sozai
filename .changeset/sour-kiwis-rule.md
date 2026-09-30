---
"@sozai/schema": minor
---

Add createValidatorCache, a bounded LRU of validators over recycled isolated factories. A failed compile or a nested $id no longer blocks a later schema with the same $id (createValidator and createValidatorFactory). A root $id equal to a meta-schema id now throws "Schema $id <id> is reserved" instead of AJV "already exists". Boolean schemas no longer throw "Invalid value used as weak map key". ValidatorCache.disposed reports whether dispose() has been called.
