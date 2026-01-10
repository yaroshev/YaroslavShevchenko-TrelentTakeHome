import { GuideViewer } from "@/components/guide-viewer";

const exampleHtml = `
<h2>Getting Started</h2>
<p>This is an example guide rendered from HTML content. The pipeline converts source documents into clean HTML like this.</p>
<h3>Key Features</h3>
<ul>
  <li>Converts PDFs and Word docs to Markdown</li>
  <li>Searches across processed content</li>
  <li>Rewrites into polished guides</li>
</ul>
<p>You can extend this component to support <strong>editing</strong> the content directly.</p>
`;

export default function ExampleGuidePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <GuideViewer
        title="Example Guide"
        description="A sample guide to demonstrate the viewer component"
        html={exampleHtml}
      />
    </main>
  );
}

