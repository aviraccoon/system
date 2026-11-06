import { type TUnsafe, Type } from "typebox";

/**
 * `{ type: "string", enum: [...] }`: the string enum shape providers that reject
 * `anyOf`/`const` accept.
 *
 * `StringEnum` from `@earendil-works/pi-ai` emits the same JSON, but its
 * published type returns a pi-schema `Schema`, which TypeBox's `Static` (what
 * `ToolDefinition.execute` types params with) resolves to `unknown`, so a tool
 * parameter built from it loses its literal union. Pi's runtime view of that
 * module builds the enum with `Type.Unsafe`, which keeps the type; this does the
 * same.
 */
export function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options?: { description?: string; default?: Values[number] },
): TUnsafe<Values[number]> {
  return Type.Unsafe<Values[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description === undefined ? {} : { description: options.description }),
    ...(options?.default === undefined ? {} : { default: options.default }),
  });
}
