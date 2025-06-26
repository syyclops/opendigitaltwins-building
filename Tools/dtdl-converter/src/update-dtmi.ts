import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recursively find all JSON files in a directory
 */
function findJsonFiles(dir: string): string[] {
  const files: string[] = [];

  function scanDirectory(currentDir: string) {
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
  }

  scanDirectory(dir);
  return files;
}

/**
 * Update DTMI identifiers in a JSON file
 */
function updateDTMIInFile(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Replace all occurrences of dtmi:com:willowinc: with dtmi:com:syyclops:
    const updatedContent = content.replace(
      /dtmi:com:willowinc:/g,
      "dtmi:com:syyclops:"
    );

    // Only write if there were changes
    if (content !== updatedContent) {
      fs.writeFileSync(filePath, updatedContent, "utf8");
      return true;
    }

    return false;
  } catch (error: any) {
    console.error(`Error processing file ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Main function
 */
function main() {
  // Find the project root by going up from __dirname until we find a .git directory or a package.json that is NOT inside Tools/dtdl-converter
  let currentDir = __dirname;
  let projectRoot: string | null = null;
  const triedPaths: string[] = [];
  while (currentDir !== path.parse(currentDir).root) {
    triedPaths.push(currentDir);
    if (
      fs.existsSync(path.join(currentDir, ".git")) ||
      (fs.existsSync(path.join(currentDir, "package.json")) &&
        !currentDir.endsWith(path.join("Tools", "dtdl-converter")))
    ) {
      projectRoot = currentDir;
      break;
    }
    currentDir = path.dirname(currentDir);
  }
  if (!projectRoot) {
    console.error(
      "Could not find project root (no .git or suitable package.json found)"
    );
    console.error("Paths tried:", triedPaths);
    process.exit(1);
  }

  const ontologyPath = path.join(projectRoot, "Ontology", "Willow");
  console.log("Project root found at:", projectRoot);
  console.log("Ontology path:", ontologyPath);

  if (!fs.existsSync(ontologyPath)) {
    console.error(`Ontology directory not found: ${ontologyPath}`);
    process.exit(1);
  }

  console.log(`Scanning for JSON files in: ${ontologyPath}`);

  const jsonFiles = findJsonFiles(ontologyPath);
  console.log(`Found ${jsonFiles.length} JSON files`);

  let updatedCount = 0;
  let errorCount = 0;

  for (const file of jsonFiles) {
    try {
      const wasUpdated = updateDTMIInFile(file);
      if (wasUpdated) {
        console.log(`Updated: ${path.relative(process.cwd(), file)}`);
        updatedCount++;
      }
    } catch (error: any) {
      console.error(`Error processing ${file}:`, error.message);
      errorCount++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Files processed: ${jsonFiles.length}`);
  console.log(`- Files updated: ${updatedCount}`);
  console.log(`- Errors: ${errorCount}`);

  if (updatedCount > 0) {
    console.log(
      `\nSuccessfully updated ${updatedCount} files with new DTMI format: dtmi:com:syyclops:`
    );
  } else {
    console.log(`\nNo files needed updating.`);
  }
}

main();
