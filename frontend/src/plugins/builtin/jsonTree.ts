export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonPathSegment = string | number;
export type JsonNodePath = readonly JsonPathSegment[];

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function updateJsonNode(
  current: JsonValue,
  path: JsonNodePath,
  depth: number,
  update: (value: JsonValue) => JsonValue
): JsonValue {
  if (depth === path.length) {
    return update(current);
  }

  const segment = path[depth];
  if (Array.isArray(current)) {
    if (
      typeof segment !== "number" ||
      !Number.isInteger(segment) ||
      segment < 0 ||
      segment >= current.length
    ) {
      throw new Error("JSON path does not point to an array item");
    }
    const next = [...current];
    next[segment] = updateJsonNode(current[segment], path, depth + 1, update);
    return next;
  }

  if (isJsonObject(current)) {
    if (typeof segment !== "string" || !hasOwn(current, segment)) {
      throw new Error("JSON path does not point to an object property");
    }
    return {
      ...current,
      [segment]: updateJsonNode(current[segment], path, depth + 1, update),
    };
  }

  throw new Error("JSON path cannot continue through a primitive value");
}

export function replaceJsonNode(
  root: JsonValue,
  path: JsonNodePath,
  value: JsonValue
): JsonValue {
  return updateJsonNode(root, path, 0, () => value);
}

export function addJsonChild(
  root: JsonValue,
  parentPath: JsonNodePath,
  key: string | undefined,
  value: JsonValue
): JsonValue {
  return updateJsonNode(root, parentPath, 0, (parent) => {
    if (Array.isArray(parent)) {
      return [...parent, value];
    }
    if (!isJsonObject(parent)) {
      throw new Error("Children can only be added to objects and arrays");
    }
    if (key === undefined || key.length === 0) {
      throw new Error("Object properties require a key");
    }
    if (hasOwn(parent, key)) {
      throw new Error(`Object property "${key}" already exists`);
    }
    return { ...parent, [key]: value };
  });
}

export function renameJsonKey(
  root: JsonValue,
  path: JsonNodePath,
  nextKey: string
): JsonValue {
  const currentKey = path[path.length - 1];
  if (typeof currentKey !== "string") {
    throw new Error("Only object properties can be renamed");
  }
  if (!nextKey) {
    throw new Error("Object properties require a key");
  }
  if (nextKey === currentKey) {
    return root;
  }

  return updateJsonNode(root, path.slice(0, -1), 0, (parent) => {
    if (!isJsonObject(parent) || !hasOwn(parent, currentKey)) {
      throw new Error("JSON path does not point to an object property");
    }
    if (hasOwn(parent, nextKey)) {
      throw new Error(`Object property "${nextKey}" already exists`);
    }

    return Object.fromEntries(
      Object.entries(parent).map(([key, value]) =>
        key === currentKey ? [nextKey, value] : [key, value]
      )
    );
  });
}

export function deleteJsonNode(root: JsonValue, path: JsonNodePath): JsonValue {
  if (path.length === 0) {
    throw new Error("The root node cannot be deleted");
  }

  const target = path[path.length - 1];
  return updateJsonNode(root, path.slice(0, -1), 0, (parent) => {
    if (Array.isArray(parent)) {
      if (
        typeof target !== "number" ||
        !Number.isInteger(target) ||
        target < 0 ||
        target >= parent.length
      ) {
        throw new Error("JSON path does not point to an array item");
      }
      return parent.filter((_, index) => index !== target);
    }

    if (!isJsonObject(parent) || typeof target !== "string" || !hasOwn(parent, target)) {
      throw new Error("JSON path does not point to an object property");
    }
    const next = { ...parent };
    delete next[target];
    return next;
  });
}

export function formatJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
