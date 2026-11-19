const LINEAR_API_URL = 'https://api.linear.app/graphql';

export class LinearApiClient {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this._viewerCache = null;
  }

  async graphql(query, variables = {}) {
    if (!this.apiKey) {
      throw new Error('LINEAR_API_KEY is required to call the Linear API');
    }

    const res = await this.fetchImpl(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Linear API HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
  }

  async getViewer() {
    if (this._viewerCache) return this._viewerCache;
    const data = await this.graphql(`
      query Viewer {
        viewer {
          id
          name
          displayName
        }
      }
    `);
    this._viewerCache = data.viewer;
    return this._viewerCache;
  }

  async getIssueWithComments(issueId) {
    const data = await this.graphql(
      `
      query IssueWithComments($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          state {
            id
            name
          }
          labels {
            nodes {
              name
            }
          }
          team {
            id
            key
            states {
              nodes {
                id
                name
                type
              }
            }
          }
          comments(first: 50) {
            nodes {
              id
              body
              createdAt
              user {
                id
                name
                displayName
              }
            }
          }
        }
      }
      `,
      { id: issueId }
    );
    return data.issue;
  }

  async createComment(issueId, body, { parentId } = {}) {
    const input = { issueId, body };
    if (parentId) {
      input.parentId = parentId;
    }
    const data = await this.graphql(
      `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment {
            id
          }
        }
      }
      `,
      { input }
    );
    if (!data.commentCreate?.success) {
      throw new Error('Linear commentCreate returned success=false');
    }
    return data.commentCreate.comment;
  }

  async updateIssue(issueId, input) {
    const data = await this.graphql(
      `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            state {
              id
              name
            }
            assignee {
              id
              name
            }
          }
        }
      }
      `,
      { id: issueId, input }
    );
    if (!data.issueUpdate?.success) {
      throw new Error('Linear issueUpdate returned success=false');
    }
    return data.issueUpdate.issue;
  }

  async moveIssueToState({ issue, stateName, assigneeId }) {
    const states = issue?.team?.states?.nodes || [];
    const target = stateName
      ? states.find(
          (s) =>
            typeof s.name === 'string' &&
            s.name.trim().toLowerCase() === stateName.trim().toLowerCase()
        )
      : null;
    const input = {};
    if (target?.id) {
      input.stateId = target.id;
    }
    if (assigneeId) {
      input.assigneeId = assigneeId;
    }
    if (Object.keys(input).length === 0) {
      return null;
    }
    return this.updateIssue(issue.id, input);
  }

  async moveIssueToReview({ issue, stateName = 'In Review', assigneeId }) {
    return this.moveIssueToState({ issue, stateName, assigneeId });
  }
}
