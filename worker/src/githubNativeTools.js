// ===================== CÔNG CỤ GITHUB "TỰ VIẾT" (không qua MCP của GitHub) =====================
// api.githubcopilot.com/mcp CHỈ chấp nhận OAuth từ 1 danh sách ứng dụng GitHub tự duyệt sẵn (VS
// Code, JetBrains, Cursor...) — OAuth App tự tạo LUÔN bị từ chối, không có cách nào lách qua.
// Nhưng token OAuth mà GitHub cấp cho app của chúng ta VẪN LÀ TOKEN THẬT, dùng gọi thẳng
// api.github.com (REST API bình thường của GitHub, không phải MCP) thì chạy đúng, không bị chặn
// gì cả — vì đây không phải giới hạn của token, mà là giới hạn riêng của MỖI ENDPOINT MCP đó.
//
// Vì vậy: định nghĩa vài công cụ hay dùng nhất, gọi thẳng REST API, format giống hệt cách MCP
// trả kết quả — để mcpChat.js dùng chung 1 luồng function-calling cho cả GitHub kiểu này lẫn các
// MCP server thật khác (Cloudflare) mà không cần biết bên trong là MCP thật hay REST tự viết.

const GITHUB_API = 'https://api.github.com';

function tool(name, description, properties, required = []) {
  return { name, description, parameters: { type: 'OBJECT', properties, required } };
}

const GITHUB_NATIVE_TOOLS = [
  tool('list_repos', 'Liệt kê repo của người dùng đang đăng nhập (mới cập nhật gần nhất trước)', {
    per_page: { type: 'INTEGER', description: 'Số lượng repo tối đa, mặc định 10' },
  }),
  tool('get_repo', 'Xem thông tin 1 repo cụ thể (mô tả, số sao, ngôn ngữ chính...)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('list_repo_contents', 'Liệt kê file/thư mục trong 1 repo tại 1 đường dẫn (để trống path để xem thư mục gốc)', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' },
  }, ['owner', 'repo']),
  tool('get_file_contents', 'Đọc nội dung 1 file trong repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, path: { type: 'STRING' },
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
  tool('list_issues', 'Liệt kê issue của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed | all' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Tạo issue mới trong 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, title: { type: 'STRING' }, body: { type: 'STRING' },
  }, ['owner', 'repo', 'title']),
  tool('list_pull_requests', 'Liệt kê pull request của 1 repo', {
    owner: { type: 'STRING' }, repo: { type: 'STRING' }, state: { type: 'STRING', description: 'open | closed | all' },
  }, ['owner', 'repo']),
  tool('search_code', 'Tìm kiếm code trên GitHub (cú pháp tìm kiếm của GitHub, ví dụ: "useState repo:facebook/react")', {
    query: { type: 'STRING' },
  }, ['query']),
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
  const data = await r.json();
  if (!r.ok) throw new Error(`GitHub API lỗi ${r.status}: ${data.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Trả về { text } giống hệt format kết quả tool của mcpClient.js để mcpChat.js dùng chung 1 luồng.
async function callGithubNativeTool(token, name, args = {}) {
  try {
    switch (name) {
      case 'list_repos': {
        const data = await githubApiFetch(token, `/user/repos?per_page=${args.per_page || 10}&sort=updated`);
        return { text: data.map(r => `${r.full_name} — ⭐${r.stargazers_count} — ${r.description || '(không có mô tả)'}`).join('\n') };
      }
      case 'get_repo': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}`);
        return { text: `${data.full_name}\n${data.description || ''}\n⭐ ${data.stargazers_count} | Ngôn ngữ: ${data.language} | Nhánh mặc định: ${data.default_branch}` };
      }
      case 'list_repo_contents': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path || ''}`);
        const list = Array.isArray(data) ? data : [data];
        return { text: list.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.path}`).join('\n') };
      }
      case 'get_file_contents': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/contents/${args.path}`);
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

        const utf8Bytes = new TextEncoder().encode(args.content);
        const binaryStr = Array.from(utf8Bytes, b => String.fromCharCode(b)).join('');
        const contentBase64 = btoa(binaryStr);

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
      case 'list_issues': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues?state=${args.state || 'open'}`);
        return { text: data.map(i => `#${i.number} [${i.state}] ${i.title}`).join('\n') || '(không có issue nào)' };
      }
      case 'create_issue': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/issues`, {
          method: 'POST', body: JSON.stringify({ title: args.title, body: args.body || '' }),
        });
        return { text: `Đã tạo issue #${data.number}: ${data.html_url}` };
      }
      case 'list_pull_requests': {
        const data = await githubApiFetch(token, `/repos/${args.owner}/${args.repo}/pulls?state=${args.state || 'open'}`);
        return { text: data.map(p => `#${p.number} [${p.state}] ${p.title}`).join('\n') || '(không có PR nào)' };
      }
      case 'search_code': {
        const data = await githubApiFetch(token, `/search/code?q=${encodeURIComponent(args.query)}`);
        return { text: (data.items || []).slice(0, 10).map(i => `${i.repository.full_name}: ${i.path}`).join('\n') || '(không tìm thấy)' };
      }
      default:
        return { text: 'Công cụ không tồn tại: ' + name, isError: true };
    }
  } catch (e) {
    return { text: e.message, isError: true };
  }
}

export { GITHUB_NATIVE_TOOLS, callGithubNativeTool };
