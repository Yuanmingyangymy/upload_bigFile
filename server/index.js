const express = require('express')
const path = require('path')
const app = express()
const cors = require('cors')
const bodyParser = require('body-parser')
const multiparty = require('multiparty')
const fse = require('fs-extra')

app.use(bodyParser.json())
app.use(cors())

const UPLOAD_DIR = path.resolve(__dirname, 'uploads')

// 上传文件
app.post('/upload', (req, res) => {
    const form = new multiparty.Form()
    form.parse(req, async (err, fields, files) => {
        if (err) {
            return res.status(401).json({
                done: 'bad',
                msg: '上传失败，请重试'
            })
        }
        const { fileHash, chunkHash } = fields
        // 临时存放目录
        // 所有上传成功的以及临时的切片文件都存放到uploads里面，为了区分不同的切片，还要再建一级目录，文件夹以fileHash命名
        const chunkPath = path.resolve(UPLOAD_DIR, fileHash[0])
        if (!fse.existsSync(chunkPath)) {
            await fse.mkdir(chunkPath)
        }
        // 将切片放到文件夹中
        const oldPath = files['chunk'][0]['path']
        await fse.move(oldPath, path.resolve(chunkPath, chunkHash[0]))

        return res.status(200).json({
            done: 'well',
            msg: '上传成功'
        })
    })
})
// 获取文件扩展名
const getExt = (filename) => {
    return filename.slice(filename.lastIndexOf('.'), filename.length)
}
// 合并文件
app.post('/merge', async (req, res) => {
    const { fileHash, fileName, size } = req.body

    const filePath = path.resolve(UPLOAD_DIR, fileHash + getExt(fileName)) //完整的文件路径
    // 如果已经存在该文件，就不需要再合并了
    if (fse.existsSync(filePath)) {
        return res.status(200).json({
            done: 'well',
            msg: '合并成功'
        })
    }
    // 如果之前没有合并过，就需要往下走
    const chunkDir = path.resolve(UPLOAD_DIR, fileHash)
    // 判断，不存在的话拿不到需要的切片
    if (!fse.existsSync(chunkDir)) {
        return res.status(401).json({
            done: 'bad',
            msg: '合并失败，请重新上传'
        })
    }

    // 开始合并
    const chunkPaths = await fse.readdir(chunkDir)
    // 切片排序
    chunkPaths.sort((a, b) => {
        return a.split('-')[1] - b.split('-')[1]
    })
    // 需要用到读写文件流的操作
    const list = chunkPaths.map((chunkName, index) => {
        return new Promise(resolve => {
            const chunkPath = path.resolve(chunkDir, chunkName)
            const readStream = fse.createReadStream(chunkPath)
            const writeStream = fse.createWriteStream(filePath, {
                start: index * size,
                end: (index + 1) * size
            })
            readStream.on('end', async () => {
                // 读完之后移除
                await fse.unlink(chunkPath)
                resolve()
            })
            // 把读的流引到写的流
            readStream.pipe(writeStream)
        })

    })

    await Promise.all(list)
    // 合并完成后删掉切片文件夹
    await fse.remove(chunkDir)


    return res.status(200).json({
        done: 'well',
        msg: '合并成功'
    })
})
// 校验
app.post('/verify', async (req, res) => {
    const { fileHash, fileName } = req.body

    const filePath = path.resolve(UPLOAD_DIR, fileHash + getExt(fileName)) //完整的文件路径

    // 返回服务器已经上传成功的切片
    const chunkDir = path.resolve(UPLOAD_DIR, fileHash)
    let chunkPaths = []
    // 如果并不存在这个文件，就不用读取操作了，不然会报错（断点续传）
    if (fse.existsSync(chunkDir)) {
        chunkPaths = await fse.readdir(chunkDir)
    }
    // 如果存在，不用上传
    if (fse.existsSync(filePath)) {
        return res.status(200).json({
            done: 'well',
            shouldUpload: false
        })

    } else {

        return res.status(200).json({
            done: 'well',
            shouldUpload: true,
            // 返回服务器上已经存在的切片，用于断点续传
            existChunks: chunkPaths
        })
    }


})


app.listen(3000, () => {
    console.log('server running at port 3000...');
})