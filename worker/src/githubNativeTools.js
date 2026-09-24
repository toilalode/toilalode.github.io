// ===================== CÔNG CỤ GITHUB "TỰ VIẾT" (không qua MCP của GitHub) =====================
// api.githubcopilot.com/mcp CHỈ chấp nhận OAuth từ 1 danh sách ứng dụng GitHub tự duyệt sẵn (VS
// Code, JetBrains, Cursor...) — OAuth App tự tạo LUÔN bị từ chối, không có cách nào lách qua.
// Nhưng token OAuth mà GitHub cấp cho app của chúng ta VẪN LÀ TOKEN THẬT, dùng gọi thẳng
// api.github.com (REST API bình thường của GitHub, không phải MCP) thì chạy đúng, không bị chặn
// gì cả — vì đây không phải giới hạn của token, mà là giới hạn riêng của MỖI ENDPOINT MCP đó.
//
// Vì vậy: định nghĩa các công cụ REST API hay dùng nhất — đọc, ghi, quản lý PR, và cả revoke —
// gọi thẳng REST API, format giống hệt cách MCP trả kết quả — để mcpChat.js dùng chung 1 luồng
// function-calling cho cả GitHub kiểu này lẫn các MCP server thật khác (Cloudflare) mà không
// cần biết bên trong là MCP thật hay REST tự viết.

const GITHUB_API = 'https://api.github.com';

function tool(name, description, properties, required = []) {
  return { name, description, parameters: { type: 'OBJECT', properties, required } };
}

const GITHUB_NATIVE_TOOLS = [
  // ---------- Đọc: user / repo ----------
  tool('get_authenticated_user', 'Xem thông tin tài khoản GitHub đang đăng nhập (username, tên, email công khai...)', {}),
  tool('list_repos', 'Liệt kê repo của người dùng đang đăng nhập (mới cập nhật gần nhất trước)', {
    per_page: { type: 'INTEGER', description: 'Số lượng repo tối đa, mặc định 10' },
  }),
  tool('list_org_repos', 'Liệt kê repo của 1 tổ chức (organization)', {
    org: { type: 'STRING' }, per_page: { type: 'INTEGER', description: 'Số lượng repo tối đa, mặc định 10' },
  }, ['org']),
  tool('get_repo', 'Xem thông tin 1 repo cụ thể (mô tả, số sao, ngôn ngữ chính...)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('create_repo', 'Tạo repo mới cho người dùng đang đăng nhập', {
    name: { type: 'STRING' }, description: { type: 'STRING' },
    private: { type: 'BOOLEAN', description: 'true nếu repo riêng tư, mặc định false (công khai)' },
  }, ['name']),
  tool('delete_repo', 'XOÁ VĨNH VIỄN 1 repo — hành động nguy hiểm, không thể hoàn tác', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('fork_repo', 'Fork (nhân bản) 1 repo về tài khoản đang đăng nhập', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('star_repo', 'Gắn sao (star) cho 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('unstar_repo', 'Bỏ sao (unstar) 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),

  // ---------- Đọc/ghi: nội dung file ----------
  tool('list_repo_contents', 'Liệt kê file/thư mục trong 1 repo tại 1 đường dẫn (để trống path để xem thư mục gốc)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' }, ref: { type: 'STRING', description: 'Tên nhánh/commit/tag, để trống dùng nhánh mặc định' },
  }, ['owner', 'repo']),
  tool('get_file_contents', 'Đọc nội dung 1 file trong repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' }, ref: { type: 'STRING', description: 'Tên nhánh/commit/tag, để trống dùng nhánh mặc định' },
  }, ['owner', 'repo', 'path']),
  tool('create_or_update_file', 'Tạo file mới hoặc SỬA ĐÈ nội dung 1 file đã có trong repo (commit trực tiếp lên 1 nhánh)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' },
    content: { type: 'STRING', description: 'Toàn bộ nội dung file sau khi sửa (không phải diff — phải là nội dung ĐẦY ĐỦ của file)' },
    message: { type: 'STRING', description: 'Nội dung commit message' },
    branch: { type: 'STRING', description: 'Tên nhánh, để trống sẽ dùng nhánh mặc định của repo' },
  }, ['owner', 'repo', 'path', 'content', 'message']),
  tool('delete_file', 'Xoá 1 file khỏi repo (commit trực tiếp lên 1 nhánh)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' },
    message: { type: 'STRING', description: 'Nội dung commit message' },
    branch: { type: 'STRING', description: 'Tên nhánh, để trống sẽ dùng nhánh mặc định của repo' },
  }, ['owner', 'repo', 'path', 'message']),

  // ---------- Nhánh & commit ----------
  tool('list_branches', 'Liệt kê các nhánh (branch) của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('create_branch', 'Tạo nhánh mới từ 1 nhánh/commit gốc (mặc định lấy từ nhánh mặc định của repo)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
    branch: { type: 'STRING', description: 'Tên nhánh mới muốn tạo' },
    from_branch: { type: 'STRING', description: 'Nhánh gốc để tạo từ đó, để trống dùng nhánh mặc định' },
  }, ['owner', 'repo', 'branch']),
  tool('delete_branch', 'Xoá 1 nhánh khỏi repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, branch: { type: 'STRING' },
  }, ['owner', 'repo', 'branch']),
  tool('list_commits', 'Liệt kê lịch sử commit của 1 nhánh trong repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, sha: { type: 'STRING', description: 'Tên nhánh, để trống dùng nhánh mặc định' },
    per_page: { type: 'INTEGER', description: 'Số lượng commit tối đa, mặc định 10' },
  }, ['owner', 'repo']),
  tool('get_commit', 'Xem chi tiết 1 commit cụ thể (kèm danh sách file thay đổi)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, sha: { type: 'STRING', description: 'SHA của commit' },
  }, ['owner', 'repo', 'sha']),
  tool('compare_commits', 'So sánh khác biệt giữa 2 nhánh/commit (dùng để xem trước những gì 1 PR sẽ mang lại)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
    base: { type: 'STRING', description: 'Nhánh/commit gốc' }, head: { type: 'STRING', description: 'Nhánh/commit muốn so sánh tới' },
  }, ['owner', 'repo', 'base', 'head']),

  // ---------- Issue ----------
  tool('list_issues', 'Liệt kê issue của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed | all' },
  }, ['owner', 'repo']),
  tool('get_issue', 'Xem chi tiết 1 issue cụ thể', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, issue_number: { type: 'INTEGER' },
  }, ['owner', 'repo', 'issue_number']),
  tool('create_issue', 'Tạo issue mới trong 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, title: { type: 'STRING' }, body: { type: 'STRING' },
  }, ['owner', 'repo', 'title']),
  tool('update_issue', 'Sửa 1 issue đã có (tiêu đề, nội dung, hoặc đóng/mở lại)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, issue_number: { type: 'INTEGER' },
    title: { type: 'STRING' }, body: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed' },
  }, ['owner', 'repo', 'issue_number']),
  tool('add_issue_comment', 'Thêm bình luận vào 1 issue hoặc pull request (PR cũng dùng chung endpoint issue comment)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, issue_number: { type: 'INTEGER' }, body: { type: 'STRING' },
  }, ['owner', 'repo', 'issue_number', 'body']),

  // ---------- Pull request ----------
  tool('list_pull_requests', 'Liệt kê pull request của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed | all' },
  }, ['owner', 'repo']),
  tool('get_pull_request', 'Xem chi tiết 1 pull request (mô tả, trạng thái mergeable, số file thay đổi...)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, pull_number: { type: 'INTEGER' },
  }, ['owner', 'repo', 'pull_number']),
  tool('create_pull_request', 'Tạo pull request mới từ 1 nhánh (head) vào 1 nhánh khác (base)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
    title: { type: 'STRING' },
    head: { type: 'STRING', description: 'Nhánh chứa thay đổi muốn merge (VD: "feature-branch", hoặc "user:branch" nếu từ 1 fork)' },
    base: { type: 'STRING', description: 'Nhánh muốn merge VÀO (VD: "main")' },
    body: { type: 'STRING' },
    draft: { type: 'BOOLEAN', description: 'true nếu muốn tạo dạng draft (bản nháp)' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('update_pull_request', 'Sửa 1 pull request đã có (tiêu đề, nội dung, hoặc đóng/mở lại)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, pull_number: { type: 'INTEGER' },
    title: { type: 'STRING' }, body: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed' },
  }, ['owner', 'repo', 'pull_number']),
  tool('merge_pull_request', 'Merge (gộp) 1 pull request vào nhánh base của nó', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, pull_number: { type: 'INTEGER' },
    commit_title: { type: 'STRING' }, commit_message: { type: 'STRING' },
    merge_method: { type: 'STRING', description: 'merge | squash | rebase, mặc định merge' },
  }, ['owner', 'repo', 'pull_number']),
  tool('list_pull_request_files', 'Liệt kê các file đã thay đổi trong 1 pull request', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, pull_number: { type: 'INTEGER' },
  }, ['owner', 'repo', 'pull_number']),
  tool('create_pull_request_review', 'Tạo review cho 1 pull request (duyệt, yêu cầu sửa, hoặc chỉ bình luận)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, pull_number: { type: 'INTEGER' },
    body: { type: 'STRING' },
    event: { type: 'STRING', description: 'APPROVE | REQUEST_CHANGES | COMMENT' },
  }, ['owner', 'repo', 'pull_number', 'event']),

  // ---------- Cộng tác viên & webhook ----------
  tool('list_collaborators', 'Liệt kê cộng tác viên (collaborator) của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('add_collaborator', 'Mời 1 người dùng làm cộng tác viên cho repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, username: { type: 'STRING' },
    permission: { type: 'STRING', description: 'pull | push | admin | maintain | triage, mặc định push' },
  }, ['owner', 'repo', 'username']),
  tool('remove_collaborator', 'Gỡ 1 người dùng khỏi danh sách cộng tác viên của repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, username: { type: 'STRING' },
  }, ['owner', 'repo', 'username']),
  tool('list_webhooks', 'Liệt kê webhook đã cấu hình cho 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('create_webhook', 'Tạo webhook mới cho 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, url: { type: 'STRING', description: 'URL sẽ nhận sự kiện' },
    events: { type: 'STRING', description: 'Danh sách sự kiện cách nhau bởi dấu phẩy, VD: "push,pull_request", mặc định "push"' },
  }, ['owner', 'repo', 'url']),
  tool('delete_webhook', 'Xoá 1 webhook khỏi repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, hook_id: { type: 'INTEGER' },
  }, ['owner', 'repo', 'hook_id']),

  // ---------- Release & gist ----------
  tool('list_releases', 'Liệt kê release của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('create_release', 'Tạo release mới cho 1 repo (gắn với 1 tag)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, tag_name: { type: 'STRING' },
    name: { type: 'STRING' }, body: { type: 'STRING' }, draft: { type: 'BOOLEAN' }, prerelease: { type: 'BOOLEAN' },
  }, ['owner', 'repo', 'tag_name']),
  tool('create_gist', 'Tạo 1 gist (đoạn code/văn bản chia sẻ nhanh) mới', {
    description: { type: 'STRING' },
    filename: { type: 'STRING' }, content: { type: 'STRING' },
    public: { type: 'BOOLEAN', description: 'true nếu gist công khai, mặc định false' },
  }, ['filename', 'content']),

  // ---------- Tìm kiếm ----------
  tool('search_code', 'Tìm kiếm code trên GitHub (cú pháp tìm kiếm của GitHub, ví dụ: "useState repo:facebook/react")', {
    query: { type: 'STRING' },
  }, ['query']),
  tool('search_repos', 'Tìm kiếm repo trên GitHub (cú pháp tìm kiếm của GitHub, ví dụ: "language:python stars:>1000")', {
    query: { type: 'STRING' },
  }, ['query']),

  // ---------- Quyền truy cập (revoke) ----------
  tool('revoke_access', 'THU HỒI (revoke) quyền truy cập OAuth hiện tại — xoá vĩnh viễn token GitHub đang dùng, ứng dụng sẽ mất toàn bộ quyền truy cập tài khoản GitHub của người dùng cho tới khi kết nối lại', {}),
];

async function githubApiFetch(token, path, options = {}) {
  const r = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'velocitix-ai',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  // 204 No Content (DELETE, unstar, add_collaborator khi chưa có lời mời sẵn...) không có body JSON.
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub API lỗi ${r.status}: ${data.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function toBase64Utf8(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  const binaryStr = Array.from(utf8Bytes, b => String.fromCharCode(b)).join('');
  return btoa(binaryStr);
}

// Trả về { text } giống hệt format kết quả tool của mcpClient.js để mcpChat.js dùng chung 1 luồng.
// env được truyền vào để công cụ revoke_access lấy GITHUB_OAUTH_CLIENT_ID/SECRET — các công cụ
// khác không cần tới env, chỉ cần token của người dùng.
async function callGithubNativeTool(token, name, args = {}, env = {}) {
  try {
    switch (name) {
      // ---------- User / repo ----------
      case 'get_authenticated_user': {
        const data = await githubApiFetch(token, `/user`);
        return { text: `${data.login} (${data.name || 'không có tên hiển thị'})\nEmail công khai: ${data.email || '(ẩn)'}\nSố repo: ${data.public_repos}` };
      }
      case 'list_repos': {
        const data = await githubApiFetch(token, `/user/repos?per_page=${args.per_page || 10}&sort=updated`);
        return { text: data.map(r => `${r.full_name} — ⭐${r.stargazers_count} — ${r.description || '(không có mô tả)'}`).join('\n') };
      }
      case 'list_org_repos': {
        const data = await githubApiFetch(token, `/orgs/${args.org}/repos?per_page=${args.per_page || 10}&sort=updated`);
        return { text: data.map(r => `${r.full_name} — ⭐${r.stargazers_count} — ${r.description || '(không có mô tả)'}`).join('\n') };
      }
      case 'get_repo': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}`);
        return { text: `${data.full_name}\n${data.description || ''}\n⭐ ${data.stargazers_count} | Ngôn ngữ: ${data.language} | Nhánh mặc định: ${data.default_branch}` };
      }
      case 'create_repo': {
        const data = await githubApiFetch(token, `/user/repos`, {
          method: 'POST', body: JSON.stringify({ name: args.name, description: args.description || '', private: !!args.private }),
        });
        return { text: `Đã tạo repo: ${data.full_name} — ${data.html_url}` };
      }
      case 'delete_repo': {
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}`, { method: 'DELETE' });
        return { text: `Đã xoá vĩnh viễn repo ${args.owner}/${args.repo}` };
      }
      case 'fork_repo': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/forks`, { method: 'POST' });
        return { text: `Đã fork: ${data.full_name} — ${data.html_url}` };
      }
      case 'star_repo': {
        await githubApiFetch(token, `/user/starred/${args.owner}/${args.repo}`, { method: 'PUT', headers: { 'Content-Length': '0' } });
        return { text: `Đã gắn sao ${args.owner}/${args.repo}` };
      }
      case 'unstar_repo': {
        await githubApiFetch(token, `/user/starred/${args.owner}/${args.repo}`, { method: 'DELETE' });
        return { text: `Đã bỏ sao ${args.owner}/${args.repo}` };
      }

      // ---------- Nội dung file ----------
      case 'list_repo_contents': {
        const q = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path || ''}${q}`);
        const list = Array.isArray(data) ? data : [data];
        return { text: list.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.path}`).join('\n') };
      }
      case 'get_file_contents': {
        const q = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}${q}`);
        let content = '(file rỗng hoặc là thư mục)';
        if (data.content) {
          const binary = atob(data.content.replace(/\n/g, ''));
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          content = new TextDecoder('utf-8').decode(bytes);
        }
        return { text: content.slice(0, 6000) }; // giới hạn tránh vượt context quá lớn
      }
      case 'create_or_update_file': {
        // Cần biết "sha" của file cũ nếu đang SỬA (GitHub bắt buộc để tránh ghi đè nhầm bản mới
        // hơn mà mình chưa thấy) — nếu file chưa tồn tại (tạo mới) thì bỏ qua bước này, lỗi 404
        // ở đây là bình thường, không phải lỗi thật.
        let sha;
        try {
          const existing = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}${args.branch ? `?ref=${args.branch}` : ''}`);
          sha = existing.sha;
        } catch (e) { /* file chưa tồn tại -> tạo mới, không cần sha */ }

        const contentBase64 = toBase64Utf8(args.content);
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, {
          method: 'PUT',
          body: JSON.stringify({ message: args.message, content: contentBase64, sha, branch: args.branch || undefined }),
        });
        return { text: `Đã ${sha ? 'sửa' : 'tạo'} file ${args.path} — commit: ${data.commit?.html_url}` };
      }
      case 'delete_file': {
        const existing = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}${args.branch ? `?ref=${args.branch}` : ''}`);
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`, {
          method: 'DELETE',
          body: JSON.stringify({ message: args.message, sha: existing.sha, branch: args.branch || undefined }),
        });
        return { text: `Đã xoá file ${args.path} — commit: ${data.commit?.html_url}` };
      }

      // ---------- Nhánh & commit ----------
      case 'list_branches': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/branches`);
        return { text: data.map(b => `${b.name}${b.protected ? ' 🔒' : ''}`).join('\n') || '(không có nhánh nào)' };
      }
      case 'create_branch': {
        const baseBranch = args.from_branch || (await githubApiFetch(token, `/repos/${args.owner}/${args.repo}`)).default_branch;
        const baseRef = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/git/ref/heads/${baseBranch}`);
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/git/refs`, {
          method: 'POST', body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: baseRef.object.sha }),
        });
        return { text: `Đã tạo nhánh ${args.branch} từ ${baseBranch}` };
      }
      case 'delete_branch': {
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/git/refs/heads/${args.branch}`, { method: 'DELETE' });
        return { text: `Đã xoá nhánh ${args.branch}` };
      }
      case 'list_commits': {
        const q = args.sha ? `&sha=${encodeURIComponent(args.sha)}` : '';
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/commits?per_page=${args.per_page || 10}${q}`);
        return { text: data.map(c => `${c.sha.slice(0, 7)} — ${c.commit.message.split('\n')[0]} (${c.commit.author?.name || '?'})`).join('\n') || '(không có commit nào)' };
      }
      case 'get_commit': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/commits/${args.sha}`);
        const files = (data.files || []).map(f => `  ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
        return { text: `${data.sha.slice(0, 7)} — ${data.commit.message}\n${files}` };
      }
      case 'compare_commits': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/compare/${args.base}...${args.head}`);
        return { text: `${data.status} — ${data.ahead_by} commit trước, ${data.behind_by} commit sau\n` + (data.files || []).map(f => `${f.status} ${f.filename}`).join('\n') };
      }

      // ---------- Issue ----------
      case 'list_issues': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues?state=${args.state || 'open'}`);
        return { text: data.map(i => `#${i.number} [${i.state}] ${i.title}`).join('\n') || '(không có issue nào)' };
      }
      case 'get_issue': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`);
        return { text: `#${data.number} [${data.state}] ${data.title}\n${data.body || ''}` };
      }
      case 'create_issue': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues`, {
          method: 'POST', body: JSON.stringify({ title: args.title, body: args.body || '' }),
        });
        return { text: `Đã tạo issue #${data.number}: ${data.html_url}` };
      }
      case 'update_issue': {
        const body = {};
        if (args.title != null) body.title = args.title;
        if (args.body != null) body.body = args.body;
        if (args.state != null) body.state = args.state;
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        return { text: `Đã cập nhật issue #${data.number} — trạng thái: ${data.state}` };
      }
      case 'add_issue_comment': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`, {
          method: 'POST', body: JSON.stringify({ body: args.body }),
        });
        return { text: `Đã thêm bình luận: ${data.html_url}` };
      }

      // ---------- Pull request ----------
      case 'list_pull_requests': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls?state=${args.state || 'open'}`);
        return { text: data.map(p => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`).join('\n') || '(không có PR nào)' };
      }
      case 'get_pull_request': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`);
        return { text: `#${data.number} [${data.state}] ${data.title}\n${data.head.ref} → ${data.base.ref}\nMergeable: ${data.mergeable}\n${data.body || ''}` };
      }
      case 'create_pull_request': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls`, {
          method: 'POST',
          body: JSON.stringify({ title: args.title, head: args.head, base: args.base, body: args.body || '', draft: !!args.draft }),
        });
        return { text: `Đã tạo PR #${data.number}: ${data.html_url}` };
      }
      case 'update_pull_request': {
        const body = {};
        if (args.title != null) body.title = args.title;
        if (args.body != null) body.body = args.body;
        if (args.state != null) body.state = args.state;
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        return { text: `Đã cập nhật PR #${data.number} — trạng thái: ${data.state}` };
      }
      case 'merge_pull_request': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`, {
          method: 'PUT',
          body: JSON.stringify({
            commit_title: args.commit_title || undefined,
            commit_message: args.commit_message || undefined,
            merge_method: args.merge_method || 'merge',
          }),
        });
        return { text: data.merged ? `Đã merge PR #${args.pull_number} — commit: ${data.sha}` : `Merge thất bại: ${data.message}` };
      }
      case 'list_pull_request_files': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/files`);
        return { text: data.map(f => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n') || '(không có file nào)' };
      }
      case 'create_pull_request_review': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/reviews`, {
          method: 'POST', body: JSON.stringify({ body: args.body || '', event: args.event }),
        });
        return { text: `Đã tạo review (${data.state}) cho PR #${args.pull_number}` };
      }

      // ---------- Cộng tác viên & webhook ----------
      case 'list_collaborators': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/collaborators`);
        return { text: data.map(c => `${c.login} (${c.permissions?.admin ? 'admin' : c.permissions?.push ? 'push' : 'pull'})`).join('\n') || '(không có cộng tác viên nào)' };
      }
      case 'add_collaborator': {
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/collaborators/${args.username}`, {
          method: 'PUT', body: JSON.stringify({ permission: args.permission || 'push' }),
        });
        return { text: `Đã mời ${args.username} làm cộng tác viên (${args.permission || 'push'})` };
      }
      case 'remove_collaborator': {
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/collaborators/${args.username}`, { method: 'DELETE' });
        return { text: `Đã gỡ ${args.username} khỏi danh sách cộng tác viên` };
      }
      case 'list_webhooks': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/hooks`);
        return { text: data.map(h => `#${h.id} — ${h.config?.url} — sự kiện: ${(h.events || []).join(', ')}`).join('\n') || '(không có webhook nào)' };
      }
      case 'create_webhook': {
        const events = (args.events || 'push').split(',').map(e => e.trim());
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/hooks`, {
          method: 'POST',
          body: JSON.stringify({ name: 'web', active: true, events, config: { url: args.url, content_type: 'json' } }),
        });
        return { text: `Đã tạo webhook #${data.id} → ${args.url}` };
      }
      case 'delete_webhook': {
        await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/hooks/${args.hook_id}`, { method: 'DELETE' });
        return { text: `Đã xoá webhook #${args.hook_id}` };
      }

      // ---------- Release & gist ----------
      case 'list_releases': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/releases`);
        return { text: data.map(r => `${r.tag_name} — ${r.name || ''}${r.draft ? ' (draft)' : ''}${r.prerelease ? ' (pre-release)' : ''}`).join('\n') || '(không có release nào)' };
      }
      case 'create_release': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/releases`, {
          method: 'POST',
          body: JSON.stringify({
            tag_name: args.tag_name, name: args.name || args.tag_name, body: args.body || '',
            draft: !!args.draft, prerelease: !!args.prerelease,
          }),
        });
        return { text: `Đã tạo release ${data.tag_name}: ${data.html_url}` };
      }
      case 'create_gist': {
        const data = await githubApiFetch(token, `/gists`, {
          method: 'POST',
          body: JSON.stringify({
            description: args.description || '',
            public: !!args.public,
            files: { [args.filename]: { content: args.content } },
          }),
        });
        return { text: `Đã tạo gist: ${data.html_url}` };
      }

      // ---------- Tìm kiếm ----------
      case 'search_code': {
        const data = await githubApiFetch(token, `/search/code?q=${encodeURIComponent(args.query)}`);
        return { text: (data.items || []).slice(0, 10).map(i => `${i.repository.full_name}: ${i.path}`).join('\n') || '(không tìm thấy)' };
      }
      case 'search_repos': {
        const data = await githubApiFetch(token, `/search/repositories?q=${encodeURIComponent(args.query)}`);
        return { text: (data.items || []).slice(0, 10).map(r => `${r.full_name} — ⭐${r.stargazers_count}`).join('\n') || '(không tìm thấy)' };
      }

      // ---------- Thu hồi quyền truy cập ----------
      case 'revoke_access': {
        // Endpoint này KHÔNG dùng Bearer token của người dùng — GitHub yêu cầu Basic Auth bằng
        // chính client_id/client_secret của app OAuth, còn access_token của người dùng được
        // truyền trong BODY để xác định grant nào cần xoá. Sau khi xoá, token cũ bị vô hiệu hoá
        // ngay lập tức và không thể dùng lại được nữa (không phải chỉ xoá phía app này).
        const clientId = env.GITHUB_OAUTH_CLIENT_ID;
        const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { text: 'Server chưa cấu hình GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET nên không thể thu hồi quyền.', isError: true };
        }
        const basic = btoa(`${clientId}:${clientSecret}`);
        const r = await fetch(`${GITHUB_API}/applications/${clientId}/grant`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Basic ${basic}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'velocitix-ai',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ access_token: token }),
        });
        if (r.status === 204) return { text: 'Đã thu hồi quyền truy cập GitHub — mọi token liên quan đã bị vô hiệu hoá. Cần kết nối lại trong Cài đặt để dùng tiếp các công cụ GitHub.' };
        const data = await r.json().catch(() => ({}));
        return { text: `Thu hồi thất bại (${r.status}): ${data.message || 'lỗi không xác định'}`, isError: true };
      }

      default:
        return { text: 'Công cụ không tồn tại: ' + name, isError: true };
    }
  } catch (e) {
    return { text: e.message, isError: true };
  }
}

export { GITHUB_NATIVE_TOOLS, callGithubNativeTool };
