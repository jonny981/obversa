---
"@obversa/runtime": patch
---

The run page asks for a judge's product decision `feedback` in its own box, so a person can say why as well as what, and the writer gets both. When the question asks for an object in `feedback`, the person types it as JSON. Left blank, it sends `{}`, or empty text when the question asks for text. It fills in a field only when its schema allows one value. Each field the page asks a person to type, an approval's note included, is labelled with its own `description` when its schema gives one. Without one, the decision box is labelled "Your decision", an approval's note has no label, and any other field is labelled with its name.
