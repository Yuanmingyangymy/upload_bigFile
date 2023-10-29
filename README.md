# 大文件上传

前端：vue3 + vite + spark-md5

后端：node.js Express框架 + cors + body-parser + multiparty + fs-extra

### 文件读取

```jsx

  <script setup lang="ts">
    const handleUpload = (e: Event) => {
      console.log((e.target as HTMLInputElement).files);
			// 读取文件
	    const files = (e.target as HTMLInputElement).files
	    if(!files) return
	    console.log(files[0]);
    }
  </script>
  
  <template>
    <div>
      <h1>大文件上传</h1>
      <input @change="handleUpload" type="file">
    </div>
  </template>
```

在浏览器中，点击input之后即可选择文件，可以看到打印如下：

可见File的第0个元素即目标文件。

### **文件分片**

[Blob.slice](https://developer.mozilla.org/zh-CN/docs/Web/API/Blob/slice)

```jsx
// 文件分片
// 1MB = 1024KB = 1024 * 1024 B
const CHUNK_SIZE = 1024 * 1024 // 1M
const createChunks = (file: File) => {
  // 从0开始
  let cur = 0
  // 声明接收chunks的数组
  let chunks = []
  while(cur < file.size) {
    const blob = file.slice(cur, cur + CHUNK_SIZE)
    chunks.push(blob)
    cur += CHUNK_SIZE
  }
  return chunks
}
```

### hash值计算

可以根据文件内容生产一个唯一的hash值，大家应该都见过用webpack打包出来的文件的文件名都有一串不一样的字符串，这个字符串就是根据文件的内容生成的hash值，文件内容变化，hash值就会跟着发生变化。我们在这里，也可以用这个办法来区分不同的文件。而且通过这个办法，我们还可以实现**秒传**的功能，怎么做呢？
就是服务器在处理上传文件的请求的时候，要先判断下对应文件的hash值有没有记录，如果A和B先后上传一份内容相同的文件，所以这两份文件的hash值是一样的。当A上传的时候会根据文件内容生成一个对应的hash值，然后在服务器上就会有一个对应的文件，B再上传的时候，服务器就会发现这个文件的hash值之前已经有记录了，说明之前已经上传过相同内容的文件了，所以就不用处理B的这个上传请求了，给用户的感觉就像是实现了秒传。

`npm i spark-md5`

在上一步获取到了文件的所有切片，我们就可以用这些切片来算该文件的ash值，但是如果一个文件特别大，每个切片的所有内容都参与计算的话会很耗时间，所有我们可以采取以下策略：
1.第一个和最后一个切片的内容全部参与计算
2.中间剩余的切片我们分别在前面、后面和中间取2个字节参与计算这样就既能保证所有的切片参与了计算，也能保证不耗费很长的时间

```tsx
const calculateHash = (chunks: Blob[]) => {
    return new Promise((resolve) => {
      // 存储需要计算hash的部分
      const target: Blob[] = []
      // 配置spark
      const spark = new SparkMD5.ArrayBuffer()
      const fileReader = new FileReader()
      
      // 第一个和最后一个的全部；中间部分取前中后各两个字节
      chunks.forEach((chunk, index) => {
        if(index === 0 || index === chunks.length - 1) {
          target.push(chunk)
        } else {
          target.push(chunk.slice(0, 2))
          target.push(chunk.slice(CHUNK_SIZE / 2, CHUNK_SIZE / 2 + 2))
          target.push(chunk.slice(CHUNK_SIZE - 2, CHUNK_SIZE))
        }
      })

      fileReader.readAsArrayBuffer(new Blob(target))
      // 注意：这个onload是异步的，计算hash的这个函数要返回Promise，确保后面使用的时候已经拿到hash值
      fileReader.onload = (e) => {
        spark.append((e.target as FileReader).result)
        // 此处拿到计算出来的hash值  spark.end()
        resolve(spark.end())
        
      }
    })
    
  }
```

### 文件上传

**前端实现**
前面已经完成了上传的前置操作，接下来就来看下如何去上传这些切片。
我们以1G的文件来分析，假如每个分片的大小为1M,那么总的分片数将会是1024个，如果我们同时发送这1024个分片，浏览器肯定处理不了，原因是切片文件过多，浏览器一次性创建了太多的请求。这是没有必要的，拿chrome浏览器来说，默认的并发数量只有6，过多的请求并不会提升上传速度，反而是给浏览器带来了巨大的负担。因此，我们有必要限制前端请求个数。
怎么做呢，我们要创建最大并发数的请求，比如6个，那么同一时刻我们就允许浏览器只发送6个请求，其中一个请求有了返回的结果后我们再发起一个新的请求，依此类推，直至所有的请求发送完毕。
上传文件时一股还要用到FormData对象，需要将我们要传递的文件还有额外信息放到这个FormData对象里面。

```tsx
// 上传分片
  const uploadChunks = async(chunks: Blob[]) => {
    // data对象数组是希望发送给服务端的内容
    const data = chunks.map((chunk, index) => {
      return {
        fileHash: fileHash.value,
        chunkHash: fileHash.value + '-' + index,
        chunk
      }
    })
    // 将对象数组转换为FormData数组
    const formDatas = data.map((item) => {
      const formData = new FormData()
      formData.append('fileHash', item.fileHash)
      formData.append('chunkHash', item.chunkHash)
      formData.append('chunk', item.chunk)
      return formData
    })
    // 浏览器会有上传请求的并发限制，需要做出约束
    const max = 6 // 最大并发请求数
    let index = 0 // 标识目前上传到第几个
    // 设置请求池，最多六个，完成一个就添加一个新的
    const taskPool: any = []
    while(index < formDatas.length) {
      const task = fetch('/upload', {
        method: 'POST',
        body: formDatas[index]
      })
      // ！！！下面这两行不理解啊，这样splice直接给task以及之后的都删了，然后还push?不懂
      taskPool.splice(taskPool.findIndex((item: any) => item === task))
      taskPool.push(task)
      // 如果请求池满了，就得等至少一个完成才可以添加
      if(taskPool.length === max) {
        await Promise.race(taskPool)
      }
      index++
    }
    await Promise.all(taskPool)
  }
```

******************后端实现******************

后端我们处理文件时需要用到multiparty这个工具，所以也是得先安装，然后再引入它。
我们在处理每个上传的分片的时候，应该先将它们临时存放到服务器的一个地方，方便我们合并的时候再去读取。为了区分不同文件的分片，我们就用文件对应的那个hash为文件夹的名称，将这个文件的所有分片放到这个文件夹中。

[**multiparty**](https://www.npmjs.com/package/multiparty)

[fs-extra](https://www.npmjs.com/package/fs-extra)

使用**fse**来操作服务端上的文件

```jsx
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
```

### 文件合并

上传文件完成之后，就可以将使用的切片合并成一个完整的文件了。

************前端实现************

发送请求

```jsx
// 文件合并
  const mergeFile = () => {
    fetch('http://localhost:3000/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileHash: fileHash.value,
        fileName: fileName.value,
        size: CHUNK_SIZE
      })
    })
    .then(res => {
      alert('合并OK')
    })
  }
```

**后端实现**

将之前上传的文件切片合并，具体要清楚各个文件夹的内容，要知道如何操作文件。使用到了读写文件流的操作。

```jsx
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
```

到此为止功能基本实现，但是还有其他情况：上传相同文件、上传过程中网络故障，又得重传整个大文件。

### 秒传&断点续传

如果内容相同的文件进行hash计算时，对应的hash值应该是一样的，而且我们在服务器上给上传的文件命名的时候就是用对应的hash值命名的，所以在上传之前可以加一个判断，如果有对应的这个文件，就不用再重复上传了，直接告诉用户上传成功，给用户的感觉就像是实现了秒传。

**前端实现**

在hash值计算完成之后，上传文件之前，发送请求，校验是否已经有传过该文件。

```jsx
// 文件校验
  const verify = () => {
    return fetch('http://localhost:3000/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileHash: fileHash.value,
        fileName: fileName.value,
      })
    })
    .then(res => res.json())
    // .then(res => {
    //   return res
    // })
    
  }
```

**后端实现**

```jsx
// 校验
app.post('/verify', (req, res) => {
    const { fileHash, fileName } = req.body

    const filePath = path.resolve(UPLOAD_DIR, fileHash + getExt(fileName)) //完整的文件路径
    // 如果存在，不用上传
    if (fse.existsSync(filePath)) {
        return res.status(200).json({
            done: 'well',
            shouldUpload: false
        })

    } else {

        return res.status(200).json({
            done: 'well',
            shouldUpload: true
        })
    }

})
```

另外就是断点续传。逻辑就是：后端在校验的时候，返回已经上传的切片。前端发起上传文件请求之前，将已经上传过的切片过滤掉，不再参与上传操作。详见verify相关代码。

### 总结

大文件上传主要就是对于文件的切片与合并操作。在服务端，需要熟悉操作文件的api，这样才能保证对于文件操作的流畅和效率性。由此可见，文件这块还是很重要的，之前没有实际操作过，有待学习。