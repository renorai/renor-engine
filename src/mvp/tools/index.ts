import type { ToolContext } from './setup.js';
import { registerRememberTool } from './remember.js';
import { registerRawRequestHandlers } from './rawRequests.js';
import { registerGetContextTool } from './getContext.js';
import { registerSaveMemoryTool } from './saveMemory.js';
import { registerRetrieveMemoryTool } from './retrieveMemory.js';
import { registerExportMemoryTool } from './exportMemory.js';
import { registerSearchHistoryTool } from './searchHistory.js';
import { registerSearchMemoryTool } from './searchMemory.js';
import { registerSearchTextTool } from './searchText.js';
import { registerLookupEntityTool } from './lookupEntity.js';
import { registerRememberNoteTool } from './rememberNote.js';
import { registerIndexMemoryTool } from './indexMemory.js';
import { registerImportTools } from './importTools.js';
import { registerMemoryMapTool } from './memoryMap.js';
import { registerReadMemoryTool } from './readMemory.js';
import { registerRetireMemoryTools } from './retireMemory.js';
import { registerDeleteRetiredMemoryTool } from './deleteRetiredMemory.js';
import { registerSharingTools } from './sharing.js';
import { registerWhatsNewTool } from './whatsNew.js';
import { registerHandoffTool } from './handoff.js';
import { registerRequestTools } from './requests.js';
import { registerMemoryStatusTool } from './memoryStatus.js';

/**
 * Registers every tool, in the order tools/list shows them. A new tool is a new file here and one line below.
 */
export function registerAllTools(ctx: ToolContext): void {
  registerRememberTool(ctx);
  registerRawRequestHandlers(ctx);
  registerGetContextTool(ctx);
  registerSaveMemoryTool(ctx);
  registerRetrieveMemoryTool(ctx);
  registerExportMemoryTool(ctx);
  registerSearchHistoryTool(ctx);
  registerSearchMemoryTool(ctx);
  registerSearchTextTool(ctx);
  registerLookupEntityTool(ctx);
  registerRememberNoteTool(ctx);
  registerIndexMemoryTool(ctx);
  registerImportTools(ctx);
  registerMemoryMapTool(ctx);
  registerReadMemoryTool(ctx);
  registerRetireMemoryTools(ctx);
  registerDeleteRetiredMemoryTool(ctx);
  registerSharingTools(ctx);
  registerWhatsNewTool(ctx);
  registerHandoffTool(ctx);
  registerRequestTools(ctx);
  registerMemoryStatusTool(ctx);
}
