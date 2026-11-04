# API Versioning System

CalVer (external) and SemVer (internal) versioning.

## Core Concept

**Always build latest format → Transform backwards automatically**

```typescript
// Your handler
const latestData = { features: { f1: {...} } };  // V1_2 format

return applyVersionChanges({
  data: latestData,
  currentVersion: new ApiVersionClass(LATEST_VERSION),
  targetVersion: ctx.apiVersion,  // From middleware
  resource: AffectedResource.Customer
});
```

## Quick Reference

### Version Comparison
```typescript
// ctx.apiVersion ready in middleware
if (ctx.apiVersion.gte(ApiVersion.V1_1)) { ... }
if (ctx.apiVersion.lt(ApiVersion.V1_2)) { ... }
```

### Version Mapping

| SemVer | CalVer | Legacy v1 | Legacy v2 |
|--------|--------|-----------|-----------|
| V1_4   | 2025-06-01 | - | 1.4 (beta) |
| V1_2   | 2025-05-05 | - | 1.2 |
| V1_1   | 2025-04-17 | - | 1.1 |
| V0_2   | 2025-04-01 | 0.2 | 1.0 |
| V0_1   | 2025-02-01 | 0.1 | - |

### Side Effects
```typescript
if (ctx.apiVersion.lt(ApiVersion.V1_1)) {
  expandArray.push(CusExpand.Invoices);
}
```

## How Transforms Work

1. **User requests V1_1**, your data is V1_2:
   ```
   V1_2 { features: { f1: {...} } }
      ↓ FeaturesArrayToObject.transform()
   V1_1 { features: [{ feature_id: 'f1', ...}] }
   ```

2. **Multiple versions back** (V1_2 → V0_2):
   ```
   V1_2 → V1_1 → V0_2
   (Each transform applied in sequence)
   ```

## File Structure

```
shared/api/
├── versionUtils/
│   ├── ApiVersion.ts              # Version enum
│   ├── ApiVersionClass.ts         # Comparison methods
│   ├── versionRegistry.ts         # SemVer ↔ CalVer mappings
│   ├── versionRegistryUtils.ts    # Helper functions
│   ├── convertVersionUtils.ts     # Conversion utils
│   ├── versionBranchUtils.ts      # Branching helpers
│   └── versionChangeUtils/
│       ├── VersionChange.ts              # Abstract base
│       ├── VersionChangeRegistryClass.ts # Registry class
│       ├── versionChangeRegistry.ts      # Register all changes
│       └── applyVersionChanges.ts        # Transform engine
└── customers/
    └── changes/                   # Customer-specific changes
        ├── V1_1_FeaturesArrayToObject.ts  # Transforms TO V1_1
        ├── V0_2_CustomerChange.ts         # Transforms TO V0_2
        ├── V0_1_CusFeatureChange.ts       # Transforms TO V0_1
        └── cusProducts/
            └── changes/
                └── V0_1_ProductItems.ts   # Transforms TO V0_1
```

### Change Organization

**Version changes live with the resource they affect:**
- Customer changes → `shared/api/customers/changes/`
- Product changes → `shared/api/products/changes/`
- Invoice changes → `shared/api/invoices/changes/`

**Naming convention:** `V{target_version}_{Description}.ts`

Files are named after the **target version** (the older version we're transforming TO):
- `V1_1_FeaturesArrayToObject.ts` - Registered at V1_2, transforms TO V1_1
- `V0_2_CustomerChange.ts` - Registered at V1_1, transforms TO V0_2
- `V0_1_CusFeatureChange.ts` - Registered at V0_2, transforms TO V0_1

This makes it clear which version format the change produces.

## Creating Version Changes

**📝 Use the template:** Copy `versionChangeUtils/versionChangeTemplate.ts` as a starting point!

### 1. Create Change File

```typescript
// shared/api/customers/changes/V1_2_MyChange.ts
import { ApiVersion } from "@api/versionUtils/ApiVersion.js";
import {
  AffectedResource,
  defineVersionChange,
} from "@api/versionUtils/versionChangeUtils/VersionChange.js";

export const V1_2_MyChange = defineVersionChange({
  oldVersion: ApiVersion.V1_2,  // Applied when targetVersion <= V1_2
  newVersion: ApiVersion.V1_3,  // Breaking change introduced in V1_3
  description: "Brief description of the change",
  affectedResources: [AffectedResource.Customer],
  newSchema: V1_3_Schema,  // Latest format
  oldSchema: V1_2_Schema,  // Older format
  
  transformResponse: ({ input }) => {
    // Transform FROM V1_3 TO V1_2
    const { newField, ...rest } = input;
    return { ...rest, oldField: newField };
  },
});
```

### 2. Register in Registry

```typescript
// versionChangeUtils/versionChangeRegistry.ts
import { V1_2_MyChange } from "@api/customers/changes/V1_2_MyChange.js";

// Register at oldVersion (V1_2), applied when targetVersion <= V1_2
const V1_2_CHANGES = [
  V1_2_MyChange,
  V1_2_AnotherChange,
];

export function registerAllVersionChanges() {
  VersionChangeRegistryClass.register({
    version: ApiVersion.V1_2,
    changes: V1_2_CHANGES
  });
  // ... other versions
}
```

### Side Effect Changes

For changes that only affect behavior (no data transformation):

```typescript
import { NoOpSchema } from "@api/versionUtils/versionChangeUtils/VersionChange.js";

export const V0_2_InvoicesAlwaysExpanded = defineVersionChange({
  oldVersion: ApiVersion.V0_2,
  newVersion: ApiVersion.V1_1,
  description: "Invoices were always expanded in V0_2 (no expand param)",
  affectedResources: [AffectedResource.Customer],
  hasSideEffects: true,  // This is a side-effect-only change
  newSchema: NoOpSchema,
  oldSchema: NoOpSchema,
  
  transformResponse: ({ input }) => input,  // No transformation
});

// In handler:
if (ctx.apiVersion.lt(ApiVersion.V1_1)) {
  // Handle side effect logic (e.g., always expand invoices)
  expandArray.push(CusExpand.Invoices);
}
```

## CalVer with .clover Support

System supports `.clover` suffix for non-breaking changes:
- `2025-04-17` → Breaking change
- `2025-04-17.clover` → Non-breaking update (future use)

Both map to same SemVer internally.

## Usage Patterns

### Standard Handler

```typescript
export const handleGet = createRoute({
  handler: async (c) => {
    const ctx = c.get("ctx");

    // Build latest
    const data = buildLatest();

    // Transform
    return c.json(applyVersionChanges({
      data,
      currentVersion: new ApiVersionClass(LATEST_VERSION),
      targetVersion: ctx.apiVersion,
      resource: AffectedResource.Customer
    }));
  }
});
```

### With Version Logic

```typescript
// Check version
if (ctx.apiVersion.lt(ApiVersion.V1_1)) {
  expandArray.push(CusExpand.Invoices);
}

// Use helper
const withItems = ctx.apiVersion.gte(ApiVersion.V0_2);
```

## Middleware

`apiVersionMiddleware` resolves version from:
1. `x-api-version` header (CalVer: "2025-04-17")
2. `org.api_version` (legacy: 1.1)
3. `org.config.api_version` (legacy: 0.2)
4. Default: V0_2

Result stored in `ctx.apiVersion` (ApiVersionClass).

## Migration from Old System

### Before
```typescript
const apiVersion = orgToVersion({ org, reqApiVersion });
if (apiVersion >= LegacyVersion.v1_1) { ... }
```

### After
```typescript
if (ctx.apiVersion.gte(ApiVersion.V1_1)) { ... }
```

## Key Principles

1. **Always build latest** - Let transforms handle old versions
2. **Transforms go backwards** - New → Old, never Old → New
3. **Object parameters** - All functions use `{ param }` signature
4. **Descending order** - Version lists newest first
5. **Resource organization** - Changes live with affected resources
