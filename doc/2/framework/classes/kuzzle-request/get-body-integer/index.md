---
code: true
type: page
title: getBodyInteger
description: KuzzleRequest class getBodyInteger() method
---

# getBodyInteger

<SinceBadge version="2.11.0" />

Gets a parameter from the request body and checks that it is an integer.

### Arguments

```ts
getBodyInteger (name: string, def: number = null): number
```

</br>

| Name   | Type              | Description    |
|--------|-------------------|----------------|
| `name` | <pre>string</pre> | Parameter name |
| `def` | <pre>number</pre> | Default value to return if the parameter is not set |


### Example

```ts
const age = request.getBodyInteger('age');
// equivalent
const age = request.input.body.age;
//+ checks to make sure that "age" is of the right type
// and throw standard API error when it's not the case
```
