const { format } = require("date-fns");
const fetch = require("node-fetch");
const path = require("path");
const prettier = require("prettier");
const https = require('https');
const xml2js = require("xml2js");
const fs = require("fs");
const slugify = require("slugify");
const htmlentities = require("he");
const {
    cleanupShortcodes,
    fixCodeBlocks,
    codeBlockDebugger,
    fixBadHTML,
    fixEmbeds,
} = require("./articleCleanup");

const unified = require("unified");
const parseHTML = require("rehype-parse");
const rehype2remark = require("rehype-remark");
const stringify = require("remark-stringify");
const imageType = require("image-type");

// Get the filename and output directory from command line arguments
let overwrite = false;
let limitFlag;
let filename;
let outputDir;
// Support flexible argument order for --limit and --overwrite
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--overwrite') {
        overwrite = true;
    } else if (process.argv[i] && process.argv[i].startsWith('--limit=')) {
        limitFlag = process.argv[i];
    } else if (!filename) {
        filename = process.argv[i];
    } else if (!outputDir && !process.argv[i].startsWith('--')) {
        outputDir = process.argv[i];
    }
}
outputDir = outputDir || 'out';
let limit = 0;

if (limitFlag && limitFlag.startsWith('--limit=')) {
    limit = parseInt(limitFlag.split('=')[1], 10);
    if (isNaN(limit) || limit <= 0) {
        limit = 0;
        console.log("Invalid limit value. Processing all posts.");
    } else {
        console.log(`Limiting processing to ${limit} posts distributed across the dataset.`);
    }
}

if (!filename) {
    console.error("Please provide a WordPress XML file as an argument");
    console.error("Usage: yarn convert <wordpress-export-file.xml> [output-directory] [--limit=N] [--overwrite]");
    console.error("Example: yarn convert export.xml my-blog-posts --limit=10 --overwrite");
    process.exit(1);
}

// Output directory handling
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
} else {
    if (!overwrite) {
        console.error(`Output directory '${outputDir}' already exists. To overwrite, rerun with the --overwrite flag. No files were deleted.`);
        process.exit(1);
    }
}

// Set up logging to both console and file
const logFile = path.join(outputDir, 'conversion-log.txt');
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Create a write stream for the log file
const logStream = fs.createWriteStream(logFile, { flags: 'w' });

// Log the command line used
const commandLine = `Command: node ${process.argv.join(' ')}`;
const startTime = new Date().toISOString();
logStream.write(`${startTime} ${commandLine}\n`);
logStream.write('INPUT: ' + path.resolve(filename) + '\n');
logStream.write('OUTPUT: ' + path.resolve(outputDir) + '\n');
logStream.write(`${startTime} Running from directory: ${process.cwd()}\n`);
logStream.write(`${startTime} Node.js version: ${process.version}\n`);
logStream.write(`${startTime} ----------------------------------------\n`);

// Override console.log and console.error to write to both console and file
console.log = function() {
    const args = Array.from(arguments);
    const timestamp = new Date().toISOString();
    const message = `${timestamp} ${args.join(' ')}\n`;
    logStream.write(message);
    originalConsoleLog.apply(console, args);
};

console.error = function() {
    const args = Array.from(arguments);
    const timestamp = new Date().toISOString();
    const message = `${timestamp} ERROR: ${args.join(' ')}\n`;
    logStream.write(message);
    originalConsoleError.apply(console, args);
};

// Clean the output directory if it exists (but preserve the log file)
if (fs.existsSync(outputDir)) {
    console.log(`Cleaning ${outputDir} directory...`);
    
    // Read directory contents
    const dirContents = fs.readdirSync(outputDir);
    
    // Remove everything except the log file
    dirContents.forEach(item => {
        if (item !== path.basename(logFile)) {
            const itemPath = path.join(outputDir, item);
            if (fs.lstatSync(itemPath).isDirectory()) {
                fs.rmSync(itemPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(itemPath);
            }
        }
    });
} else {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Process the export file
processExport(filename, outputDir);

// Add error handling for the main process
process.on('exit', (code) => {
    console.log(`Process exiting with code: ${code}`);
    logStream.end();
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    logStream.end();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logStream.end();
    process.exit(1);
});

function processExport(file, outputDir) {
    console.log(`[IN] processExport: file=${JSON.stringify(file)}, outputDir=${JSON.stringify(outputDir)}, limit=${typeof limit !== 'undefined' ? limit : 'undefined'}`);
    const parser = new xml2js.Parser();

    fs.readFile(file, function (err, data) {
        if (err) {
            return console.log("Error: " + err);
        }

        parser.parseString(data, function (err, result) {
            if (err) {
                return console.log("Error parsing xml: " + err);
            }
            console.log("Parsed XML");

            const allPosts = result.rss.channel[0].item.filter(
                (p) => p["wp:post_type"][0] === "post"
            );
            
            let postsToProcess = allPosts;
            
            // Apply limit if specified
            if (limit > 0 && limit < allPosts.length) {
                console.log(`Total posts: ${allPosts.length}, processing ${limit} distributed samples`);
                
                // Group posts by first letter of title for distributed sampling
                const postsByFirstLetter = {};
                allPosts.forEach(post => {
                    const title = typeof post.title === "string" ? post.title : post.title[0];
                    const firstLetter = title.trim().charAt(0).toLowerCase();
                    if (!postsByFirstLetter[firstLetter]) {
                        postsByFirstLetter[firstLetter] = [];
                    }
                    postsByFirstLetter[firstLetter].push(post);
                });
                
                // Get the most common first letters
                const letterGroups = Object.keys(postsByFirstLetter).sort((a, b) => 
                    postsByFirstLetter[b].length - postsByFirstLetter[a].length
                );
                
                // Distribute the samples across letter groups
                postsToProcess = [];
                let remainingLimit = limit;
                let letterIndex = 0;
                
                // First pass: take one from each letter group until we've reached the limit
                while (remainingLimit > 0 && letterIndex < letterGroups.length) {
                    const letter = letterGroups[letterIndex];
                    if (postsByFirstLetter[letter].length > 0) {
                        postsToProcess.push(postsByFirstLetter[letter].shift());
                        remainingLimit--;
                    }
                    letterIndex = (letterIndex + 1) % letterGroups.length;
                    
                    // If we've gone through all letter groups, break if no more posts
                    if (letterIndex === 0) {
                        const anyPostsLeft = letterGroups.some(l => postsByFirstLetter[l].length > 0);
                        if (!anyPostsLeft) break;
                    }
                }
                
                console.log(`Processing ${postsToProcess.length} posts from ${letterGroups.length} different letter groups`);
            }

            // Create output directory if it doesn't exist
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            let results = [];
postsToProcess.forEach(post => {
    results.push(processPost(post, outputDir));
});
console.log(`[OUT] processExport: processed ${results.length} posts.`);
        });
    });
}

function constructImageName({ urlParts, buffer }) {
    const pathParts = path.parse(
        urlParts.pathname
            .replace(/^\//, "")
            .replace(/\//g, "-")
            .replace(/\*/g, "")
    );
    const { ext } = imageType(new Buffer(buffer));

    return `${pathParts.name}.${ext}`;
}

async function downloadFile(url) {
    // FIX: self-signing should only be allowed with a flag
    try {
        const agent = new https.Agent({
            rejectUnauthorized: false,  // Allow self-signed certificates
            NODE_TLS_REJECT_UNAUTHORIZED: '0'  // Alternative way to allow self-signed certs
        });
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            agent
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response;
    } catch (e) {
        console.log(`Failed to download: ${url}`, e.message);
        throw e;
    }
}

async function processImage({ url, postData, images, directory }) {
    console.log(`[IN] processImage: url=${JSON.stringify(url)}, directory=${JSON.stringify(directory)}, imagesCount=${images ? images.length : 0}`);
    if (!url || typeof url !== 'string') {
        console.log("Skipping invalid image URL:", url);
        return [postData, images];
    }

    try {
        const cleanUrl = htmlentities.decode(url).trim();
        console.log("Downloading image:", cleanUrl);
        
        const response = await downloadFile(cleanUrl);
        const buffer = await response.buffer();
        
        // Extract filename from URL
        const urlObj = new URL(cleanUrl);
        const pathParts = path.parse(urlObj.pathname);
        const imageName = pathParts.base;
        
        const imageDir = path.join(directory);
        // Create directory only when we have an actual image to save
        if (!fs.existsSync(imageDir)) {
            console.log(`Creating image directory: ${imageDir}`);
            fs.mkdirSync(imageDir, { recursive: true });
        }

        const imagePath = path.join(imageDir, imageName);
        fs.writeFileSync(imagePath, buffer);
        console.log("Saved image:", imagePath);

        // Create a copy of postData to modify
        let updatedPostData = postData;
        if (updatedPostData && typeof updatedPostData === 'string') {
            // Escape special characters in URL for regex
            const escapedUrl = cleanUrl.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(escapedUrl, 'g');
            // Reference image relative to the .mdx file, in the subdir named after the slug
const relImagePath = `./${path.basename(directory)}/${imageName}`;
updatedPostData = updatedPostData.replace(regex, relImagePath);
        }

        images.push(imageName);
console.log(`[OUT] processImage: saved=${imageName}, imagesCount=${images.length}`);
return [updatedPostData, images];
    } catch (e) {
        console.log("Failed to process image:", url, "Error:", e.message);
        return [postData, images];
    }
}

async function processImages({ postData, directory }) {
    console.log(`[IN] processImages: directory=${JSON.stringify(directory)}, postDataLength=${postData ? postData.length : 0}`);
    if (!postData) return [postData, []];

    let updatedPostData = postData;
    let images = [];
    
    // Match both single and double quoted src attributes
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
    const matches = [...updatedPostData.matchAll(imgRegex)];

    for (const match of matches) {
        try {
            const url = match[1].trim();
            if (!url) continue;

            console.log("Processing image URL:", url);
            const [newPostData, newImages] = await processImage({
                url,
                postData: updatedPostData,
                images,
                directory,
            });
            
            updatedPostData = newPostData;
            images = [...new Set([...images, ...newImages])]; // Remove duplicates
        } catch (e) {
            console.log("Error processing image match:", e.message);
        }
    }

    return [updatedPostData, images];
}

async function processPost(post, outputDir) {
    console.log(`[IN] processPost: postTitle=${JSON.stringify(post && (typeof post.title === 'string' ? post.title : post.title && post.title[0]))}, outputDir=${JSON.stringify(outputDir)}`);
    console.log("Processing Post");

    const postTitle =
        typeof post.title === "string" ? post.title : post.title[0];
    console.log("Post title: " + postTitle);
    const postDate = isFinite(new Date(post.pubDate))
        ? new Date(post.pubDate)
        : new Date(post["wp:post_date"]);
    console.log("Post Date: " + postDate);
    let postData = post["content:encoded"][0];
    console.log("Post length: " + postData.length + " bytes");
    const slug = slugify(postTitle, {
        remove: /[^\w\s]/g,
    })
        .toLowerCase()
        .replace(/\*/g, "");
    console.log("Post slug: " + slug);

    const mediaDirectory = `${outputDir}/${slug}`;
    // Don't create media directory yet - only create it when we actually have images
    
    // takes the longest description candidate
    const postMeta = post["wp:postmeta"] || [];
    const description = [
        post.description,
        ...postMeta.filter(
            (meta) =>
                meta["wp:meta_key"] && 
                (meta["wp:meta_key"][0].includes("metadesc") ||
                meta["wp:meta_key"][0].includes("description"))
        ),
    ].filter(Boolean).sort((a, b) => b.length - a.length)[0];

    const heroURLs = (post["wp:postmeta"] || [])
        .filter(
            (meta) =>
                meta["wp:meta_key"] && 
                (meta["wp:meta_key"][0].includes("opengraph-image") ||
                meta["wp:meta_key"][0].includes("twitter-image"))
        )
        .map((meta) => meta["wp:meta_value"][0])
        .filter((url) => url.startsWith("http"));

    let heroImage = "";

    let images = [];
    if (heroURLs.length > 0) {
        const url = heroURLs[0];
        [postData, images] = await processImage({
            url,
            postData,
            images,
            directory: mediaDirectory,
        });
    }

    [postData, images] = await processImages({ postData, directory: mediaDirectory });

    heroImage = images.find((img) => !img.endsWith("gif"));

    const markdown = await new Promise((resolve, reject) => {
        unified()
            .use(parseHTML, {
                fragment: true,
                emitParseErrors: true,
                duplicateAttribute: false,
            })
            .use(fixCodeBlocks)
            .use(fixEmbeds)
            .use(rehype2remark)
            .use(cleanupShortcodes)
            .use(stringify, {
                fences: true,
                listItemIndent: 1,
                gfm: false,
                pedantic: false,
            })
            .process(fixBadHTML(postData), (err, markdown) => {
                if (err) {
                    reject(err);
                } else {
                    let content = markdown.contents;
                    content = content.replace(
                        /(?<=https?:\/\/.*)\\_(?=.*\n)/g,
                        "_"
                    );
                    resolve(prettier.format(content, { parser: "mdx" }));
                }
            });
    });

    try {
        postTitle.replace("\\", "\\\\").replace(/"/g, '\\"');
    } catch (e) {
        console.log("FAILED REPLACE", postTitle);
    }

    const redirect_from = post.link[0]
        .replace("https://swizec.com", "")
        .replace("https://www.swizec.com", "");
    let frontmatter;
    try {
        frontmatter = [
            "---",
            `title: '${postTitle.replace(/'/g, "''")}'`,
            `description: "${description}"`,
            `published: ${format(postDate, "yyyy-MM-dd")}`,
            `redirect_from: 
            - ${redirect_from}`,
        ];
    } catch (e) {
        console.log("----------- BAD TIME", postTitle, postDate);
        throw e;
    }

    const categories = post.category && post.category.map((cat) => cat["_"]);
    if (categories && categories.length > 0) {
        frontmatter.push(`categories: "${categories.join(", ")}"`);
    }

    frontmatter.push(`hero: ${heroImage || "../../../defaultHero.jpg"}`);
    frontmatter.push("---");
    frontmatter.push("");

    fs.writeFile(
        `${outputDir}/${slug}.mdx`,
        frontmatter.join("\n") + markdown,
        function (err) {
            if (err) {
                console.error("Error writing file:", err);
            } else {
                console.log(`[OUT] processPost: slug=${slug}, file=${outputDir}/${slug}.mdx, images=${JSON.stringify(images)}, heroImage=${JSON.stringify(heroImage)}`);
            }
        }
    );
}

function getPaddedMonthNumber(month) {
    if (month < 10) return "0" + month;
    else return month;
}

function getPaddedDayNumber(day) {
    if (day < 10) return "0" + day;
    else return day;
}
