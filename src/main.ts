import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL") || 'gpt-4';
const CUSTOM_RULES_PATH: string = core.getInput("custom_rules_path");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  customRules: string | null
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails, customRules);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails,
  customRules: string | null
): string {
  const defaultRules = `你的任務是審查 Pull Request。指示：
- 以以下 JSON 格式提供回覆： {"reviews": [{"lineNumber": <行號>, "reviewComment": "<審查評論>"}]}
- 不要給予正面評論或讚美。
- 僅在有可改進之處時提供評論和建議，否則 "reviews" 應為空陣列。
- 以 GitHub Markdown 格式撰寫評論。
- 僅將給定的描述用於整體上下文，並僅評論程式碼。
- 重要：切勿建議在程式碼中添加註釋。
- 所有審查評論都必須用中文撰寫。`;

  const rules = customRules || defaultRules;

  return `${rules}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${
  // @ts-expect-error - ln and ln2 exists where needed
  chunk.changes.map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`).join("\n")
}\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    core.info(`[AI_REVIEW_DEBUG] Prompt sent to OpenAI: ${prompt}`);
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  core.info('[AI_REVIEW_DEBUG] Starting AI Code Reviewer');
  
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  core.info(`[AI_REVIEW_DEBUG] Event: ${eventData.action}`);

  if (eventData.action === "opened") {
    core.info('[AI_REVIEW_DEBUG] Getting diff for opened PR');
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    core.info('[AI_REVIEW_DEBUG] Getting diff for synchronized PR');
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    core.info(`[AI_REVIEW_DEBUG] Unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
    return;
  }
  
  if (!diff) {
    core.info('[AI_REVIEW_DEBUG] No diff found');
    return;
  }

  core.info(`[AI_REVIEW_DEBUG] Diff length: ${diff.length} characters`);

  const parsedDiff = parseDiff(diff);
  
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  core.info(`[AI_REVIEW_DEBUG] Exclude patterns: ${excludePatterns.join(', ')}`);

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });
  
  core.info(`[AI_REVIEW_DEBUG] Files before filtering: ${parsedDiff.length}, after filtering: ${filteredDiff.length}`);
  
  if (filteredDiff.length === 0) {
    core.info('[AI_REVIEW_DEBUG] All files filtered out. No code to review.');
    return;
  }

  let customRules: string | null = null;
  if (CUSTOM_RULES_PATH) {
    try {
      customRules = readFileSync(CUSTOM_RULES_PATH, "utf8");
      core.info('[AI_REVIEW_DEBUG] Custom rules loaded successfully');
    } catch (error) {
      core.warning(`Could not read custom rules file at ${CUSTOM_RULES_PATH}. Using default rules.`);
    }
  }
  
  core.info('[AI_REVIEW_DEBUG] Starting code analysis...');
  const comments = await analyzeCode(filteredDiff, prDetails, customRules);
  
  core.info(`[AI_REVIEW_DEBUG] Analysis complete. Found ${comments.length} comments`);
  
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
    core.info('[AI_REVIEW_DEBUG] Review posted successfully');
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
