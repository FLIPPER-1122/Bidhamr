// Testfilerne køres i navneorden (01, 02 ... 99), så slutafstemningen (99)
// altid kommer sidst.
import { BaseSequencer, type TestSpecification } from "vitest/node";

export default class Navneorden extends BaseSequencer {
  async sort(filer: TestSpecification[]): Promise<TestSpecification[]> {
    return [...filer].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
  async shard(filer: TestSpecification[]): Promise<TestSpecification[]> {
    return filer;
  }
}
