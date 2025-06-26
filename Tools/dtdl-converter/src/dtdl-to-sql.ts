import slugify from "slugify";
import { v7 as uuidv7 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DTDLInterface {
  "@id": string;
  "@type": string;
  displayName?: string;
  description?: string;
  extends?: string[];
  contents?: DTDLContent[];
}

interface DTDLContent {
  "@id": string;
  "@type": string;
  name: string;
  displayName?: string;
  description?: string;
  schema?: DTDLSchema;
  writable?: boolean;
  minMultiplicity?: number;
  maxMultiplicity?: number;
  target?: string;
}

interface DTDLSchema {
  "@type"?: string;
  enumValues?: Array<{
    name: string;
    displayName?: string;
    enumValue: number;
  }>;
}

class DTDLToSQL {
  private classMap: Map<string, string>; // Maps DTMI to DTMI (no UUID needed)
  private propertyTypeMap: Map<string, string>; // Maps property types to UUIDs
  private enumDefMap: Map<string, string>; // Maps enum definitions to UUIDs
  private ontologyId: string;
  private timestamp: string;
  private models: DTDLInterface[] = [];

  constructor() {
    this.classMap = new Map();
    this.propertyTypeMap = new Map();
    this.enumDefMap = new Map();
    this.ontologyId = "dtmi:syyclops:Syyclops;1"; // Using DTMI format for ontology ID
    this.timestamp = new Date().toISOString();
  }

  async loadDTDL(ontologyPath?: string): Promise<void> {
    try {
      // Default to the Ontology/Syyclops directory relative to the project root
      const defaultPath = path.join(
        __dirname,
        "..",
        "..",
        "..",
        "Ontology",
        "Willow"
      );
      const targetPath = ontologyPath || defaultPath;

      console.log(`Scanning for DTDL files in: ${targetPath}`);

      if (!fs.existsSync(targetPath)) {
        throw new Error(`Ontology directory not found: ${targetPath}`);
      }

      const dtdlFiles = this.findDTDLFiles(targetPath);
      console.log(`Found ${dtdlFiles.length} DTDL files`);

      for (const file of dtdlFiles) {
        try {
          const dtdlData = await fs.promises.readFile(file, "utf8");
          const parsed = JSON.parse(dtdlData);

          // Handle top-level array of models
          if (Array.isArray(parsed)) {
            this.models.push(...parsed);
          } else if (parsed.models && Array.isArray(parsed.models)) {
            // Model set format
            this.models.push(...parsed.models);
          } else if (parsed["@id"] && parsed["@type"]) {
            // Single model format
            this.models.push(parsed);
          }
        } catch (fileError) {
          console.warn(
            `Warning: Failed to parse file ${file}: ${
              fileError instanceof Error ? fileError.message : String(fileError)
            }`
          );
        }
      }

      console.log(`Successfully loaded ${this.models.length} DTDL models`);
    } catch (error) {
      throw new Error(
        `Failed to load DTDL Schema: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private findDTDLFiles(dir: string): string[] {
    const files: string[] = [];

    const scanDirectory = (currentDir: string) => {
      const items = fs.readdirSync(currentDir);

      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (item.endsWith(".json")) {
          files.push(fullPath);
        }
      }
    };

    scanDirectory(dir);
    return files;
  }

  private getStringOrObjectValue(
    val: string | Record<string, string> | undefined
  ): string {
    if (typeof val === "string") return val;
    if (val && typeof val === "object") {
      // Try English first, then any value
      return val["en"] || Object.values(val)[0] || "";
    }
    return "";
  }

  generateSQL(): string {
    const sql: string[] = [];
    sql.push("BEGIN;");

    // Insert ontology
    sql.push(`
INSERT INTO syyclops.ontologies (id, name, slug, version, created_at)
VALUES (
    '${this.ontologyId}',
    'Syyclops',
    'syyclops',
    '1.0',
    '${this.timestamp}'
);`);

    // Insert property types
    const propertyTypes = [
      "string",
      "boolean",
      "integer",
      "double",
      "dateTime",
      "date",
      "array",
      "enum",
    ];
    propertyTypes.forEach((type) => {
      const typeId = this.generateUUID();
      this.propertyTypeMap.set(type, typeId);
      sql.push(`
INSERT INTO syyclops.ontology_property_types (id, name, created_at)
VALUES (
    '${typeId}',
    '${type}',
    '${this.timestamp}'
);`);
    });

    // First pass: Create mappings for all interfaces
    for (const model of this.models) {
      this.classMap.set(model["@id"], model["@id"]); // Use DTMI as both key and value
    }

    // Second pass: Process interfaces with inheritance relationships
    for (const model of this.models) {
      const dtmi = model["@id"];
      const displayName =
        this.getStringOrObjectValue(model.displayName) ||
        this.extractNameFromDTMI(dtmi);
      const description = this.getStringOrObjectValue(model.description) || "";

      // Get parent interfaces
      const extendsList = model.extends || [];
      const parentId = extendsList.length > 0 ? extendsList[0] : null; // Take first parent
      const isRoot = extendsList.length === 0;

      sql.push(`
INSERT INTO syyclops.ontology_classes (id, name, slug, ontology_id, is_root, parent_id, created_at)
VALUES (
    '${dtmi}',
    '${displayName.replace(/'/g, "''")}',
    '${slugify(displayName, { lower: true })}',
    '${this.ontologyId}',
    ${isRoot},
    ${parentId ? `'${parentId}'` : "NULL"},
    '${this.timestamp}'
);`);

      // Add description as comment if available
      if (description) {
        sql.push(
          `COMMENT ON COLUMN syyclops.ontology_classes.name IS '${description.replace(
            /'/g,
            "''"
          )}';`
        );
      }
    }

    // Process relationships and properties
    for (const model of this.models) {
      const contents = model.contents || [];

      for (const content of contents) {
        if (content["@type"] === "Relationship") {
          // Handle relationships
          const relId = this.generateUUID();
          const relName = content.name;
          const description =
            this.getStringOrObjectValue(content.description) || "";
          const target = content.target;
          const minMultiplicity = content.minMultiplicity || 0;
          const maxMultiplicity = content.maxMultiplicity;

          if (target) {
            sql.push(`
INSERT INTO syyclops.ontology_class_relations (
    id, name, source_ontology_class_id, target_ontology_class_id,
    min_cardinality, max_cardinality, created_at
)
VALUES (
    '${relId}',
    '${relName}',
    '${model["@id"]}',
    '${target}',
    ${minMultiplicity},
    ${maxMultiplicity ? maxMultiplicity : "NULL"},
    '${this.timestamp}'
);`);

            // Add description as comment if available
            if (description) {
              sql.push(
                `COMMENT ON COLUMN syyclops.ontology_class_relations.name IS '${description.replace(
                  /'/g,
                  "''"
                )}';`
              );
            }
          }
        } else if (content["@type"] === "Property") {
          // Handle properties
          const propId = this.generateUUID();
          const propName = content.name;
          const description =
            this.getStringOrObjectValue(content.description) || "";
          const schema = content.schema;
          const writable = content.writable || false;

          if (schema) {
            const propertyType = this.mapDTDLTypeToPropertyType(schema);
            const typeId = this.propertyTypeMap.get(propertyType);

            if (typeId) {
              sql.push(`
INSERT INTO syyclops.ontology_class_properties (
    id, name, ontology_class_id, ontology_property_type_id, is_nullable, created_at
)
VALUES (
    '${propId}',
    '${propName}',
    '${model["@id"]}',
    '${typeId}',
    ${!writable},
    '${this.timestamp}'
);`);

              // Add description as comment if available
              if (description) {
                sql.push(
                  `COMMENT ON COLUMN syyclops.ontology_class_properties.name IS '${description.replace(
                    /'/g,
                    "''"
                  )}';`
                );
              }

              // Handle enum values if it's an enum property
              if (propertyType === "enum" && schema.enumValues) {
                const enumDefId = this.generateUUID();
                this.enumDefMap.set(propId, enumDefId);

                sql.push(`
INSERT INTO syyclops.ontology_enum_definitions (id, name, created_at)
VALUES (
    '${enumDefId}',
    '${propName}_enum',
    '${this.timestamp}'
);`);

                // Update property to reference enum definition
                sql.push(`
UPDATE syyclops.ontology_class_properties 
SET enum_definition_id = '${enumDefId}'
WHERE id = '${propId}';`);

                // Insert enum values
                for (const enumValue of schema.enumValues) {
                  sql.push(`
INSERT INTO syyclops.ontology_enum_definition_values (
    enum_definition_id, display_name, value, created_at
)
VALUES (
    '${enumDefId}',
    '${this.getStringOrObjectValue(enumValue.displayName) || enumValue.name}',
    '${enumValue.enumValue}',
    '${this.timestamp}'
);`);
                }
              }
            }
          }
        }
      }
    }

    sql.push("COMMIT;");
    return sql.join("\n");
  }

  private extractNameFromDTMI(dtmi: string): string {
    // Extract name from DTMI like "dtmi:syyclops:Agent;1" -> "Agent"
    const parts = dtmi.split(":");
    const lastPart = parts[parts.length - 1];
    return lastPart.split(";")[0];
  }

  private mapDTDLTypeToPropertyType(schema: string | DTDLSchema): string {
    if (typeof schema === "string") {
      switch (schema) {
        case "string":
          return "string";
        case "boolean":
          return "boolean";
        case "integer":
          return "integer";
        case "double":
          return "double";
        case "dateTime":
          return "dateTime";
        case "date":
          return "date";
        default:
          return "string";
      }
    } else if (schema["@type"] === "Array") {
      return "array";
    } else if (schema.enumValues) {
      return "enum";
    }
    return "string";
  }

  private generateUUID(): string {
    return uuidv7();
  }
}

// Main execution
async function main() {
  try {
    const converter = new DTDLToSQL();

    await converter.loadDTDL();
    const sql = converter.generateSQL();
    const outputFile = path.join(
      __dirname,
      "..",
      "data",
      "syyclops_schema.sql"
    );
    await fs.promises.writeFile(outputFile, sql);

    console.log(`SQL schema generated successfully: ${outputFile}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
